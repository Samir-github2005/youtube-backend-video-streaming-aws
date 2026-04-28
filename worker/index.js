import dotenv from "dotenv";
dotenv.config();
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";

const execAsync = promisify(exec);

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3000";

const REGION = process.env.AWS_REGION || "ap-south-1";
const credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};

const s3 = new S3Client({ region: REGION, credentials });
const sqs = new SQSClient({ region: REGION, credentials });

const QUEUE_URL = process.env.SQS_QUEUE_URL;
const RAW_BUCKET = process.env.S3_RAW_BUCKET;
const PROCESSED_BUCKET = process.env.S3_PROCESSED_BUCKET;

// ─── Quality profiles ───────────────────────────────────────────────────────
// Each profile defines the FFmpeg output settings and the folder name in S3.
// BANDWIDTH is used in the master playlist (bits per second).

const QUALITIES = [
    {
        label: "480p",
        resolution: "854x480",
        videoBitrate: "800k",
        audioBitrate: "96k",
        bandwidth: 896000,       // videoBitrate + audioBitrate in bps
        codecs: "avc1.640028,mp4a.40.2",
    },
    {
        label: "720p",
        resolution: "1280x720",
        videoBitrate: "2500k",
        audioBitrate: "128k",
        bandwidth: 2628000,
        codecs: "avc1.640028,mp4a.40.2",
    },
    {
        label: "1080p",
        resolution: "1920x1080",
        videoBitrate: "5000k",
        audioBitrate: "192k",
        bandwidth: 5192000,
        codecs: "avc1.640028,mp4a.40.2",
    },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Download an S3 object to a local file path */
async function downloadFromS3(bucket, key, destPath) {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(destPath);
        response.Body.pipe(writeStream);
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
    });
}

/** Upload every file inside a local directory to S3 under a given prefix */
async function uploadDirectoryToS3(localDir, bucket, s3Prefix) {
    const files = fs.readdirSync(localDir);
    for (const file of files) {
        const filePath = path.join(localDir, file);
        const fileBody = fs.readFileSync(filePath);
        const s3Key = `${s3Prefix}/${file}`;

        const isPlaylist = file.endsWith(".m3u8");
        const contentType = isPlaylist ? "application/x-mpegURL" : "video/mp2t";

        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: s3Key,
            Body: fileBody,
            ContentType: contentType,
            // Playlists must never be cached — segments are immutable and can be cached long
            CacheControl: isPlaylist ? "no-store" : "public, max-age=31536000, immutable",
        }));
        console.log(`  [S3] Uploaded: s3://${bucket}/${s3Key}`);
    }
}

/**
 * Transcode a single quality rendition to HLS using FFmpeg.
 * Output goes to: outputDir/<label>/index.m3u8 + segment*.ts
 */
async function transcodeQuality(inputPath, outputDir, quality) {
    const { label, resolution, videoBitrate, audioBitrate } = quality;
    const qualityDir = path.join(outputDir, label);
    await fs.promises.mkdir(qualityDir, { recursive: true });

    const hlsPath = path.join(qualityDir, "index.m3u8");
    const segmentPattern = path.join(qualityDir, "segment%03d.ts");

    const cmd = [
        "ffmpeg",
        "-i", `"${inputPath}"`,
        "-vf", `scale=${resolution}`,   // force exact resolution
        "-c:v", "libx264",
        "-b:v", videoBitrate,
        "-force_key_frames", `"expr:gte(t,n_forced*2)"`,
        "-sc_threshold", "0",
        "-c:a", "aac",
        "-b:a", audioBitrate,
        "-hls_time", "10",
        "-hls_playlist_type", "vod",
        "-hls_segment_filename", `"${segmentPattern}"`,
        "-start_number", "0",
        `"${hlsPath}"`,
    ].join(" ");

    console.log(`  [FFmpeg] Starting ${label} transcoding...`);
    await execAsync(cmd);
    console.log(`  [FFmpeg] ${label} done.`);
}

/**
 * Generate a master HLS playlist (master.m3u8) that references all quality renditions.
 * This is what the Video.js player should load — it auto-switches quality based on bandwidth.
 */
function generateMasterPlaylist(qualities) {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:3", ""];

    for (const q of qualities) {
        // NAME must NOT be quoted — some HLS parsers (including hls.js used by video.js)
        // reject quoted values for NAME and silently fall back to the first stream only
        lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${q.bandwidth},RESOLUTION=${q.resolution},CODECS="${q.codecs}",NAME=${q.label}`);
        lines.push(`${q.label}/index.m3u8`);
        lines.push("");
    }

    return lines.join("\n");
}

// ─── Mark video as ready in DynamoDB via the backend API ────────────────────

async function markReady(videoId) {
    return new Promise((resolve, reject) => {
        const url = new URL(`${BACKEND_URL}/videos/${videoId}/status`);
        const client = url.protocol === 'https:' ? https : http;

        const body = JSON.stringify({ status: 'ready' });
        const req = client.request(url, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    console.log(`  [Backend] DynamoDB status updated to ready for videoId=${videoId}`);
                    resolve();
                } else {
                    reject(new Error(`PATCH /videos/${videoId}/status returned HTTP ${res.statusCode}: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ─── Main job processor ─────────────────────────────────────────────────────

async function processJob(message) {
    const body = JSON.parse(message.Body);
    const { videoId, s3Key, bucket } = body;

    console.log(`\n[Worker] Received job — videoId=${videoId}, key=${s3Key}`);

    // ── Idempotency guard ──────────────────────────────────────────────────────
    // If master.m3u8 already exists on S3 this job was already completed
    // (e.g. SQS retried after a markReady failure). Skip re-transcoding.
    try {
        await s3.send(new HeadObjectCommand({
            Bucket: PROCESSED_BUCKET,
            Key: `hls/${videoId}/master.m3u8`,
        }));
        console.log(`  [Worker] master.m3u8 already on S3 — skipping transcode for videoId=${videoId}`);
        return; // nothing to do; poll() will still call markReady and delete the SQS message
    } catch (headErr) {
        // 404 = not yet processed, continue normally
        const is404 = headErr.name === 'NotFound' || headErr.$metadata?.httpStatusCode === 404;
        if (!is404) throw headErr; // unexpected S3 error — let poll() handle it
    }
    // ──────────────────────────────────────────────────────────────────────────

    const tmpInput = `/tmp/${videoId}.mp4`;
    const tmpOutputDir = `/tmp/${videoId}`;

    try {
        // 1. Download raw video from S3
        console.log("  [S3] Downloading raw video...");
        await downloadFromS3(bucket || RAW_BUCKET, s3Key, tmpInput);
        console.log("  [S3] Download complete.");

        // 2. Transcode all qualities in parallel
        console.log(`  [FFmpeg] Transcoding ${QUALITIES.length} quality renditions in parallel...`);
        await Promise.all(
            QUALITIES.map(q => transcodeQuality(tmpInput, tmpOutputDir, q))
        );
        console.log("  [FFmpeg] All renditions complete.");

        // 3. Generate and save master playlist locally
        const masterContent = generateMasterPlaylist(QUALITIES);
        const masterPath = path.join(tmpOutputDir, "master.m3u8");
        fs.writeFileSync(masterPath, masterContent);
        console.log("  [Playlist] master.m3u8 generated.");

        // 4. Upload each quality folder to S3
        for (const q of QUALITIES) {
            const qualityDir = path.join(tmpOutputDir, q.label);
            const s3Prefix = `hls/${videoId}/${q.label}`;
            console.log(`  [S3] Uploading ${q.label} segments...`);
            await uploadDirectoryToS3(qualityDir, PROCESSED_BUCKET, s3Prefix);
        }

        // 5. Upload master playlist to S3 (never cache — it's the entry point)
        await s3.send(new PutObjectCommand({
            Bucket: PROCESSED_BUCKET,
            Key: `hls/${videoId}/master.m3u8`,
            Body: fs.readFileSync(masterPath),
            ContentType: "application/x-mpegURL",
            CacheControl: "no-store",
        }));
        console.log(`  [S3] master.m3u8 uploaded.`);
        console.log(`\n  ✅ Transcode complete! Stream at: hls/${videoId}/master.m3u8`);

    } finally {
        // Always clean up temp files
        try { fs.rmSync(tmpInput, { force: true }); } catch (_) { }
        try { fs.rmSync(tmpOutputDir, { recursive: true, force: true }); } catch (_) { }
    }
}

// ─── SQS poll loop ──────────────────────────────────────────────────────────

async function poll() {
    console.log("[Worker] Polling SQS for jobs...");
    while (true) {
        let response;
        try {
            response = await sqs.send(new ReceiveMessageCommand({
                QueueUrl: QUEUE_URL,
                MaxNumberOfMessages: 1,
                WaitTimeSeconds: 20,
            }));
        } catch (err) {
            console.error("[Worker] SQS receive error:", err.message);
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }

        const messages = response.Messages || [];
        if (messages.length === 0) continue;

        const msg = messages[0];
        const { videoId } = JSON.parse(msg.Body);

        // ── Step 1: Transcode + upload to S3 ──────────────────────────────────
        // Only re-queue (skip delete) if transcoding itself fails.
        try {
            await processJob(msg);
        } catch (err) {
            console.error(`[Worker] Transcode failed for videoId=${videoId}:`, err.message);
            // Leave message in SQS — it will become visible again after visibility timeout
            continue;
        }

        // ── Step 2: Delete the SQS message ────────────────────────────────────
        // Do this immediately after successful transcode so SQS never retries it,
        // even if the DynamoDB update below fails.
        try {
            await sqs.send(new DeleteMessageCommand({
                QueueUrl: QUEUE_URL,
                ReceiptHandle: msg.ReceiptHandle,
            }));
            console.log("[Worker] SQS message deleted.");
        } catch (err) {
            console.error("[Worker] Failed to delete SQS message (will retry on next poll):", err.message);
        }

        // ── Step 3: Update DynamoDB status → ready ────────────────────────────
        // Failure here does NOT cause re-transcoding — the SQS message is already gone.
        try {
            await markReady(videoId);
            console.log(`[Worker] Done ✅ videoId=${videoId}\n`);
        } catch (err) {
            console.error(`[Worker] markReady failed for videoId=${videoId}:`, err.message);
            console.error("  → HLS is on S3 but DynamoDB status was NOT updated. Fix manually via PATCH /videos/:id/status");
        }
    }
}

// ─── Startup ─────────────────────────────────────────────────────────────────

const required = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "SQS_QUEUE_URL", "S3_RAW_BUCKET", "S3_PROCESSED_BUCKET"];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
    console.error("[Worker] Missing env vars:", missing.join(", "));
    process.exit(1);
}

poll().catch(err => {
    console.error("[Worker] Fatal error:", err);
    process.exit(1);
});
