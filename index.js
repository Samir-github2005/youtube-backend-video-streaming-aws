import express from "express";
import cors from "cors";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import { console } from "inspector";

const execAsync = promisify(exec);

const app = express();
const PORT = 3000;

app.use(cors({
    origin: ["http://localhost:5173"],
    credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/output", express.static("output"));

const storage = multer.diskStorage({
    destination: "uploads/",
    filename: (req, file, cb) => {
        const uniqueName = uuidv4() + path.extname(file.originalname);
        cb(null, uniqueName);
    },
});

const upload = multer({ storage: storage });

app.post("/upload", upload.single("file"), async (req, res) => {
    try {
        const videoId= uuidv4()
        const videoPath = req.file.path;
        const outputPath = `output/${videoId}`;
        const hlsPath = `${outputPath}/index.m3u8`;
        console.log(hlsPath)

        // Create output directory if it doesn't exist
        await fs.promises.mkdir(outputPath, { recursive: true });

        // Run FFmpeg to change resolution to 480p
        const ffmpegCommand = `ffmpeg -i ${videoPath} -codec:v libx264 -codec:a aac -hls_time 10 -hls_playlist_type vod -hls_segment_filename "${outputPath}/segment%03d.ts" -start_number 0 ${hlsPath}`;
        exec(ffmpegCommand, (error, stdout, stderr) => {
            if (error) {
                console.error(`exec error: ${error}`);
                return;
            }
            console.log(`stdout: ${stdout}`);
            console.log(`stderr: ${stderr}`);
            const videoUrl= `http://localhost:${PORT}/output/${videoId}/index.m3u8`;
            res.json({
                success: true,
                original: videoPath,
                processed: videoUrl,
            });
        });
    } catch (error) {
        console.error("Error processing video:", error);
        res.status(500).json({ success: false, error: "Failed to process video" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});