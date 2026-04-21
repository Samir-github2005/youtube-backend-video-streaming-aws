import dotenv from "dotenv";
dotenv.config();
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execAsync = promisify(exec);

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
    },
    {
        label: "720p",
        resolution: "1280x720",
        videoBitrate: "2500k",
        audioBitrate: "128k",
        bandwidth: 2628000,
    },
    {
        label: "1080p",
        resolution: "1920x1080",
        videoBitrate: "5000k",
        audioBitrate: "192k",
        bandwidth: 5192000,
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
        lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${q.bandwidth},RESOLUTION=${q.resolution},NAME=${q.label}`);
        lines.push(`${q.label}/index.m3u8`);
        lines.push("");
    }

    return lines.join("\n");
}

// ─── Main job processor ─────────────────────────────────────────────────────

async function processJob(message) {
    const body = JSON.parse(message.Body);
    const { videoId, s3Key, bucket } = body;

    console.log(`\n[Worker] Received job — videoId=${videoId}, key=${s3Key}`);

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
        console.log(`\n  ✅ Done! Stream at: hls/${videoId}/master.m3u8`);

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
        try {
            await processJob(msg);

            await sqs.send(new DeleteMessageCommand({
                QueueUrl: QUEUE_URL,
                ReceiptHandle: msg.ReceiptHandle,
            }));
            console.log("[Worker] SQS message deleted.\n");

        } catch (err) {
            console.error("[Worker] Job failed:", err.message);
            // Don't delete — SQS will retry after visibility timeout
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
