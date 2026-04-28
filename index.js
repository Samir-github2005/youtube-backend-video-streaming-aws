import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();
import multer from "multer";
import multerS3 from "multer-s3";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const app = express();
const PORT = 3000;

const s3 = new S3Client({
    region: process.env.AWS_REGION || "ap-south-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);

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

        // Save to DynamoDB
        await dynamo.send(new PutCommand({
            TableName: process.env.DYNAMO_TABLE,
            Item:{
                videoId,
                title: req.body.title ,
                description: req.body.description,
                status: 'processing',
                createdAt: new Date().toISOString()
            }
        }))

        res.json({
            message: "Upload successful, transcoding job queued",
            videoId,
            s3Key,
            s3Url,
        });
    });
});

app.get('/videos', async (req, res) => {
  try {
    const data = await dynamo.send(new ScanCommand({ TableName: process.env.DYNAMO_TABLE }));
    const items = data.Items || [];

    // For every video still marked 'processing', check S3 in parallel.
    // If master.m3u8 already exists, flip DynamoDB to 'ready' immediately.
    await Promise.all(
      items
        .filter(v => v.status === 'processing')
        .map(async (v) => {
          try {
            await s3.send(new HeadObjectCommand({
              Bucket: process.env.S3_PROCESSED_BUCKET,
              Key: `hls/${v.videoId}/master.m3u8`,
            }));

            // File is on S3 — update DynamoDB and the in-memory item
            await dynamo.send(new UpdateCommand({
              TableName: process.env.DYNAMO_TABLE,
              Key: { videoId: v.videoId },
              UpdateExpression: 'SET #s = :s',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: { ':s': 'ready' },
            }));

            v.status = 'ready'; // reflect in the response without a second scan
            console.log(`[Videos] Auto-reconciled videoId=${v.videoId} → ready`);
          } catch (err) {
            const is404 = err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404;
            if (!is404) {
              console.error(`[Videos] Reconcile error for videoId=${v.videoId}:`, err.name, err.message, err.$metadata);
            }
            // still processing or an unexpected error — leave status as-is
          }
        })
    );

    res.json(items);
  } catch (err) {
    console.error('[Videos] Error:', err.message);
    res.status(500).json({ error: 'Failed to list videos' });
  }
});


app.get('/status/:videoId', async (req, res) => {
  const { videoId } = req.params;

  try {
    await s3.send(new HeadObjectCommand({
      Bucket: process.env.S3_PROCESSED_BUCKET,
      Key: `hls/${videoId}/master.m3u8`
    }));

    // file exists → processing is done
    res.json({ status: 'ready' });

  } catch (err) {
    // AWS SDK v3 sends HTTP 404 as err.name='NotFound' OR err.$metadata.httpStatusCode=404
    const is404 = err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404;
    if (is404) {
      res.json({ status: 'processing' });
    } else {
      console.error('[Status] Unexpected S3 error:', err.message);
      res.status(500).json({ status: 'failed' });
    }
  }
});

// Worker calls this once HLS upload is complete
app.patch('/videos/:videoId/status', async (req, res) => {
  const { videoId } = req.params;
  const { status } = req.body;

  if (!status) return res.status(400).json({ error: 'status is required' });

  try {
    await dynamo.send(new UpdateCommand({
      TableName: process.env.DYNAMO_TABLE,
      Key: { videoId },
      UpdateExpression: 'SET #s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status },
    }));
    console.log(`[PATCH] videoId=${videoId} status set to ${status}`);
    res.json({ ok: true, videoId, status });
  } catch (err) {
    console.error('[PATCH] DynamoDB update error:', err.message);
    res.status(500).json({ error: 'Failed to update status', detail: err.message });
  }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});