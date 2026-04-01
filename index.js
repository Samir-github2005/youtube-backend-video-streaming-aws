import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();
import multer from "multer";
import multerS3 from "multer-s3";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const app = express();
const PORT = 3000;

const s3 = new S3Client({
    region: process.env.AWS_REGION || "ap-south-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const sqs = new SQSClient({
    region: process.env.AWS_REGION || "ap-south-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

app.use(cors({
    origin: ["http://localhost:5173"],
    credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({
    storage: multerS3({
        s3: s3,
        bucket: process.env.S3_RAW_BUCKET,
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: (req, file, cb) => {
            const uniqueName = uuidv4() + path.extname(file.originalname);
            cb(null, `upload/${uniqueName}`);
        },
    })
});

// Health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/upload", (req, res) => {
    upload.single("file")(req, res, async (err) => {
        // Catch multer/S3 errors explicitly
        if (err) {
            console.error("[Upload] Multer/S3 error:", err);
            return res.status(500).json({ error: "Upload failed", detail: err.message });
        }

        if (!req.file) {
            return res.status(400).json({ error: "No file uploaded" });
        }

        const videoId = uuidv4();
        const s3Key = req.file.key;
        const s3Url = req.file.location;
        console.log(`[Upload] File stored at S3: ${s3Key}`);

        // Dispatch SQS job
        try {
            await sqs.send(new SendMessageCommand({
                QueueUrl: process.env.SQS_QUEUE_URL,
                MessageBody: JSON.stringify({
                    videoId,
                    s3Key,
                    bucket: process.env.S3_RAW_BUCKET,
                }),
            }));
            console.log(`[SQS] Job dispatched — videoId=${videoId}`);
        } catch (sqsErr) {
            console.error("[SQS] Failed to send message:", sqsErr.message);
            return res.status(500).json({ error: "Upload succeeded but failed to queue job", detail: sqsErr.message });
        }

        res.json({
            message: "Upload successful, transcoding job queued",
            videoId,
            s3Key,
            s3Url,
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});