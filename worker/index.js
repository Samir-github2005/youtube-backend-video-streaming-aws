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

        // Pick the right content-type
        const contentType = file.endsWith(".m3u8")
            ? "application/x-mpegURL"
            : "video/mp2t";

        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: s3Key,
            Body: fileBody,
            ContentType: contentType,
        }));
        console.log(`  [S3] Uploaded: s3://${bucket}/${s3Key}`);
    }
}

/** Transcode a video file to HLS segments using FFmpeg */
async function transcodeToHLS(inputPath, outputDir) {
    await fs.promises.mkdir(outputDir, { recursive: true });
    const hlsPath = path.join(outputDir, "index.m3u8");
    const segmentPattern = path.join(outputDir, "segment%03d.ts");

    const cmd = [
        "ffmpeg",
        "-i", `"${inputPath}"`,
        "-codec:v", "libx264",
        "-codec:a", "aac",
        "-hls_time", "10",
        "-hls_playlist_type", "vod",
        `-hls_segment_filename`, `"${segmentPattern}"`,
        "-start_number", "0",
        `"${hlsPath}"`,
    ].join(" ");

    console.log("  [FFmpeg] Running transcoding...");
    await execAsync(cmd);
    console.log("  [FFmpeg] Transcoding complete.");
}

// ─── Main poll loop ─────────────────────────────────────────────────────────

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

        // 2. Transcode with FFmpeg
        await transcodeToHLS(tmpInput, tmpOutputDir);

        // 3. Upload HLS output to processed bucket
        console.log("  [S3] Uploading HLS segments...");
        await uploadDirectoryToS3(tmpOutputDir, PROCESSED_BUCKET, `hls/${videoId}`);
        console.log(`  [S3] Upload complete. Stream at: hls/${videoId}/index.m3u8`);

    } finally {
        // 4. Clean up temp files (always, even on error)
        try { fs.rmSync(tmpInput, { force: true }); } catch (_) {}
        try { fs.rmSync(tmpOutputDir, { recursive: true, force: true }); } catch (_) {}
    }
}

async function poll() {
    console.log("[Worker] Polling SQS for jobs...");
    while (true) {
        let response;
        try {
            response = await sqs.send(new ReceiveMessageCommand({
                QueueUrl: QUEUE_URL,
                MaxNumberOfMessages: 1,
                WaitTimeSeconds: 20,   // long-polling — avoids tight spin loops
            }));
        } catch (err) {
            console.error("[Worker] SQS receive error:", err.message);
            await new Promise(r => setTimeout(r, 5000));  // back-off before retry
            continue;
        }

        const messages = response.Messages || [];
        if (messages.length === 0) {
            // No messages — loop back immediately (long-poll already waited 20s)
            continue;
        }

        const msg = messages[0];
        try {
            await processJob(msg);

            // 5. Delete message from SQS only on success
            await sqs.send(new DeleteMessageCommand({
                QueueUrl: QUEUE_URL,
                ReceiptHandle: msg.ReceiptHandle,
            }));
            console.log("[Worker] Job done — SQS message deleted.");

        } catch (err) {
            console.error("[Worker] Job failed:", err.message);
            // Don't delete — SQS will make it visible again after visibility timeout
        }
    }
}

// Validate required env vars before starting
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
