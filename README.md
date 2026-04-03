# 🎬 Video Streaming Pipeline

A full-stack cloud video processing pipeline. Upload a video → it gets transcoded to HLS format by a worker on EC2 → streamed back via CloudFront CDN.

---

## 🏗️ Architecture Overview

```
[React Frontend]
      |
      | POST /upload (multipart)
      ↓
[Express API (Node.js)]
      |
      | multer-s3
      ↓
[S3 — Raw Bucket]          ←── stores original uploaded video
      |
      | SQS message { videoId, s3Key, bucket }
      ↓
[Amazon SQS Queue]
      |
      | Worker polls every 20s (long-poll)
      ↓
[EC2 Instance — Docker]
      |
      | FFmpeg → HLS segments (.ts + .m3u8)
      ↓
[S3 — Processed Bucket]    ←── stores hls/<videoId>/index.m3u8 + segment*.ts
      |
      | CloudFront CDN
      ↓
[React Frontend — Video.js Player]
```

---

## 🧰 Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite + Video.js |
| API Server | Node.js + Express + multer-s3 |
| Job Queue | Amazon SQS |
| Worker | Node.js + FFmpeg (Dockerized on EC2) |
| Storage | Amazon S3 (two buckets) |
| CDN | Amazon CloudFront |

---

## 📁 Project Structure

```
project/
├── index.js              # Express API server
├── package.json
├── .env                  # API environment variables (never commit this)
│
├── worker/               # Standalone EC2 worker
│   ├── index.js          # SQS polling + FFmpeg + S3 upload logic
│   ├── package.json
│   ├── Dockerfile
│   ├── .dockerignore
│   └── .env.example      # Template for worker env vars
│
└── frontend/             # React + Vite app
    ├── src/
    │   ├── App.jsx        # Upload UI + status polling
    │   └── VideoPlayer.jsx # Video.js wrapper component
    └── .env              # Frontend environment variables
```

---

## ☁️ AWS Setup (Step by Step)

### 1. S3 — Create Two Buckets

Go to **AWS Console → S3 → Create bucket**

#### Bucket 1: Raw Videos
- **Name:** `your-raw-bucket` (e.g. `youtube-raw-video`)
- **Region:** `ap-south-1`
- Block all public access: **ON** (private — only the API writes here)

#### Bucket 2: Processed Videos
- **Name:** `your-processed-bucket` (e.g. `youtube-processed-video`)
- **Region:** `ap-south-1`
- Block all public access: **ON** (CloudFront reads via OAC, not public)

#### Add CORS to the Processed Bucket
Go to **S3 → processed bucket → Permissions → CORS → Edit** and paste:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": [
      "http://localhost:5173",
      "https://your-production-domain.com"
    ],
    "ExposeHeaders": []
  }
]
```

---

### 2. SQS — Create a Queue

Go to **AWS Console → SQS → Create queue**

- **Type:** Standard
- **Name:** `video-jobs` (or any name)
- **Visibility timeout:** 300 seconds (gives worker enough time to transcode)
- **Message retention:** 4 days (default)
- Leave everything else as default → **Create queue**

Copy the **Queue URL** — you'll need it in `.env`.

---

### 3. IAM — Create a User / Role with Permissions

#### For local development (API + Worker running locally):
Go to **IAM → Users → Create user → Attach policies directly**, create a custom policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:HeadObject"],
      "Resource": [
        "arn:aws:s3:::your-raw-bucket/*",
        "arn:aws:s3:::your-processed-bucket/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:ap-south-1:YOUR_ACCOUNT_ID:video-jobs"
    }
  ]
}
```

After creating the user, go to **Security credentials → Create access key** → copy `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.

#### For EC2 worker (preferred — no hardcoded keys):
Go to **IAM → Roles → Create role → EC2**, attach the same custom policy above. Then when launching your EC2 instance, attach this role under **Advanced → IAM instance profile**.

---

### 4. EC2 — Launch the Worker Instance

Go to **AWS Console → EC2 → Launch Instance**

- **AMI:** Ubuntu 24.04 LTS
- **Instance type:** `t3.medium` (FFmpeg is CPU-heavy; t2.micro will be very slow)
- **Key pair:** Create or select a `.pem` key pair (you'll need it to SSH)
- **Security group:** Allow inbound SSH (port 22) from your IP
- **IAM instance profile:** attach the role you created above
- Launch the instance

#### Install Docker on EC2
SSH into your instance:
```bash
ssh -i your-key.pem ubuntu@<EC2_PUBLIC_IP>
```

Then install Docker:
```bash
sudo apt update && sudo apt install -y docker.io
sudo systemctl enable --now docker
sudo usermod -aG docker ubuntu
# Exit and SSH back in for group change to take effect
exit
```

#### Copy Worker Files to EC2
From your local machine (PowerShell):
```powershell
scp -r "path/to/project/worker" ubuntu@<EC2_PUBLIC_IP>:~/worker
```

#### Configure and Run the Worker
```bash
cd ~/worker
cp .env.example .env
nano .env          # fill in your real values

docker build -t video-worker .
docker run -d --env-file .env --name worker video-worker
docker logs -f worker   # watch logs
```

---

### 5. CloudFront — Create a Distribution

Go to **AWS Console → CloudFront → Create distribution**

#### Origin settings:
- **Origin domain:** select your **processed S3 bucket** from the dropdown
- **Origin access:** select **Origin access control settings (recommended)**
- Click **Create new OAC** → give it a name → Create
- CloudFront will prompt you to copy a bucket policy → go to the processed S3 bucket → Permissions → Bucket policy → paste it → Save

#### Default cache behavior:
- **Viewer protocol policy:** Redirect HTTP to HTTPS
- **Allowed HTTP methods:** GET, HEAD
- **Cache policy:** `CachingOptimized` (AWS managed)
- **Response headers policy:** Create a new one called `cors-hls`:
  - Enable **CORS** → Access-Control-Allow-Origin: `All origins`
  - Access-Control-Allow-Methods: `GET, HEAD`

#### Create the distribution → wait ~5 minutes to deploy.

Copy the **Distribution domain name** (e.g. `d1xxxxx.cloudfront.net`) — this goes into `VITE_CLOUDFRONT_URL`.

#### After deploying, invalidate cache if needed:
```
CloudFront → Invalidations → Create → /*
```

---

## ⚙️ Environment Variables

### API Server — `project/.env`
```env
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=ap-south-1
S3_RAW_BUCKET=your-raw-bucket
S3_PROCESSED_BUCKET=your-processed-bucket
SQS_QUEUE_URL=https://sqs.ap-south-1.amazonaws.com/YOUR_ACCOUNT_ID/video-jobs
```

### Worker — `project/worker/.env`
```env
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=ap-south-1
S3_RAW_BUCKET=your-raw-bucket
S3_PROCESSED_BUCKET=your-processed-bucket
SQS_QUEUE_URL=https://sqs.ap-south-1.amazonaws.com/YOUR_ACCOUNT_ID/video-jobs
```
> If using an EC2 IAM role, you can omit `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.

### Frontend — `project/frontend/.env`
```env
VITE_BACKEND_URL=http://localhost:3000
VITE_CLOUDFRONT_URL=https://dXXXXXXXXXXXX.cloudfront.net
```

---

## 🚀 Running Locally

### 1. Install dependencies
```bash
# API
cd project
npm install

# Frontend
cd project/frontend
npm install
```

### 2. Start the API
```bash
cd project
nodemon index.js
# or: node index.js
```

### 3. Start the frontend
```bash
cd project/frontend
npm run dev
```

### 4. (Optional) Run the worker locally
> Requires FFmpeg installed locally: `winget install Gyan.FFmpeg` on Windows
```bash
cd project/worker
npm install
node index.js
```

Open `http://localhost:5173`, upload a video, and watch it process.

---

## 🐳 Worker — Docker Commands

```bash
# Build
docker build -t video-worker .

# Run
docker run -d --env-file .env --name worker video-worker

# View logs
docker logs -f worker

# Stop
docker stop worker

# Restart
docker start worker
```

---

## 💸 Cost-Saving Tips

When not actively developing, **stop** (don't terminate) the EC2 instance:
- **EC2 → Instances → Stop instance** (preserves your files and Docker image)
- SQS and S3 have negligible idle costs
- CloudFront charges only for data transferred

To resume:
1. **Start** the EC2 instance (note: public IP changes on restart)
2. SSH in and run: `docker start worker`

---

## 🔍 How the Status Polling Works

1. Frontend uploads the video → API returns a `videoId`
2. Frontend calls `GET /status/:videoId` every 5 seconds
3. API checks if `hls/<videoId>/index.m3u8` exists in the processed S3 bucket using `HeadObject`
4. Once found → returns `{ status: 'ready' }` → frontend loads the Video.js player with the CloudFront HLS URL

---

## 🛣️ Roadmap / Next Steps

- [ ] Multiple resolution outputs (360p, 480p, 720p, 1080p) from a single upload
- [ ] Progress bar during transcoding
- [ ] Host the Express API on EC2 or ECS (currently local only)
- [ ] Add user authentication
- [ ] Auto-scaling EC2 workers based on SQS queue depth
