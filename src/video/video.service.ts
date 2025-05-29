// src/video/video.service.ts
import { Injectable, InternalServerErrorException, NotFoundException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Video, VideoDocument, IdentifiedSceneSubdocument, RunwayOutputImageSubdocument } from './schemas/video.schema';
import * as mongoose from 'mongoose';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fsPromises from 'fs/promises';
import * as fs from 'fs';
import * as path from 'path';

// --- RunwayML SDK Import ---
import RunwayML from '@runwayml/sdk';

// --- Google Generative AI Import (CRITICAL: Ensure this is at the very top) ---
import { GoogleGenerativeAI, Part } from '@google/generative-ai';


// --- Configuration ---
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe'; // Path to ffprobe executable
const execAsync = promisify(exec);

// --- API Keys and IDs (READ FROM ENVIRONMENT VARIABLES) ---
const geminiApiKey: string | undefined = "AIzaSyAVT-FclFGjB3XtCVTCn_lvW1UvooKUQuY";
const runwayApiKey: string | undefined = "key_baef1fa53aab435d802843aad0df1242afb20c609cbf0adfb77c7574fc43489adfe2a82edd64203e6914c04ea4e10eaca04da51db4bcda4c0ba4a3def47d5623";
const runwayModelId: string = process.env.RUNWAYML_MODEL_ID || 'gen4_image';
const runwayWorkspaceId: string = process.env.RUNWAYML_WORKSPACE_ID || 'Creative';

// --- Base URL for serving local frames to RunwayML ---
const BASE_URL = 'https://6698-2401-4900-1c62-9978-841a-c5c9-3cd6-5a4d.ngrok-free.app';

// --- Directory for RunwayML Output Images ---
const RUNWAY_OUTPUT_DIR = path.join(process.cwd(), 'runway_output_images');
console.log("RUNWAY_OUTPUT_DIR", RUNWAY_OUTPUT_DIR);

// Immediately create the RunwayML output directory if it doesn't exist
(async () => {
  try {
    await fsPromises.access(RUNWAY_OUTPUT_DIR, fs.constants.F_OK)
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      await fsPromises.mkdir(RUNWAY_OUTPUT_DIR, { recursive: true });
      console.log(`Created RunwayML output directory: ${RUNWAY_OUTPUT_DIR}`);
    } else {
      console.error(`Failed to check or create RunwayML output directory ${RUNWAY_OUTPUT_DIR}:`, e);
    }
  }
})();


// --- Interface for Identified Scene Output (aligns with schema) ---
interface IdentifiedScene {
  timestamp: number; // This will now store milliseconds
  description?: string;
  frameLocalPaths?: string[];
}

@Injectable()
export class VideoService implements OnModuleInit {
  private geminiGenAI: GoogleGenerativeAI;
  private geminiModel: any;
  private runwayClient: RunwayML;

  constructor(@InjectModel(Video.name) private videoModel: Model<VideoDocument>) {}

  // NestJS lifecycle hook: guarantees the module is initialized and dependencies are available
  async onModuleInit() {
    // --- Gemini API Setup ---
    if (!geminiApiKey) {
      console.error("CRITICAL ERROR: GEMINI_API_KEY environment variable is not set. Gemini API calls will fail.");
      (this.geminiGenAI as any) = null;
      (this.geminiModel as any) = null;
    } else {
      try {
        this.geminiGenAI = new GoogleGenerativeAI(geminiApiKey);
        this.geminiModel = this.geminiGenAI.getGenerativeModel({ model: "gemini-1.5-pro" });
        console.log("Gemini API initialized.");
      } catch (e) {
        console.error("Error initializing Gemini API:", e);
        (this.geminiGenAI as any) = null;
        (this.geminiModel as any) = null;
      }
    }

    // --- RunwayML Client Initialization ---
    if (!runwayApiKey) {
      console.error("CRITICAL ERROR: RUNWAYML_API_KEY environment variable is not set. RunwayML API calls will fail.");
      (this.runwayClient as any) = null;
    } else {
      try {
        this.runwayClient = new RunwayML({ apiKey: runwayApiKey });
        console.log(`RunwayML client initialized for Workspace ID: ${runwayWorkspaceId}`);
      } catch (e) {
        console.error("Error initializing RunwayML SDK:", e);
        (this.runwayClient as any) = null; // Corrected from runiniGenAI
      }
    }
  }


  // --- Public Methods for Controller ---

  async saveVideoMetadata(file: Express.Multer.File, prompt: string): Promise<VideoDocument> {
    console.log('Multer file object:', file);
    console.log('Multer file path:', file.path);
    console.log('Multer file mimetype:', file.mimetype);

    const createdVideo = new this.videoModel({
      originalFileName: file.originalname,
      mimeType: file.mimetype, // This will be 'application/octet-stream' for your sbom.mp4
      localFilePath: file.path,
      userPrompt: prompt,
      status: 'PENDING',
      identifiedScenes: [],
      runwayGeneratedImages: [],
    });
    const savedVideo = await createdVideo.save();
    console.log('Saved Video Document (from DB):', savedVideo);

    setTimeout(() => {
      this.processVideo((savedVideo._id as Types.ObjectId).toString())
        .catch(err => console.error(`Error processing video ${savedVideo._id}:`, err));
    }, 100);

    return savedVideo;
  }

  async getVideoById(id: string): Promise<VideoDocument | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      console.warn(`[getVideoById] Invalid MongoDB ObjectId format: '${id}'`);
      return null;
    }
    try {
      const video = await this.videoModel.findById(id).exec();
      return video;
    } catch (queryError: any) {
      console.error(`[getVideoById] ERROR during Mongoose findById for ID '${id}':`, queryError.message);
      return null;
    }
  }

  async getSpecificFramePath(videoId: string, sceneIndex: number, frameIndex: number): Promise<string | null> {
    const video = await this.getVideoById(videoId);
    if (!video || !video.identifiedScenes || !video.identifiedScenes[sceneIndex] || !video.identifiedScenes[sceneIndex].frameLocalPaths || frameIndex < 0 || frameIndex > 2) {
      console.warn(`[getSpecificFramePath] Frame path not found: videoId=${videoId}, sceneIndex=${sceneIndex}, frameIndex=${frameIndex}`);
      return null;
    }
    const path = video.identifiedScenes[sceneIndex].frameLocalPaths[frameIndex];
    if (path) {
      return path;
    }
    return null;
  }

  async getRunwayOutputImagePath(videoId: string, runwayOutputIndex: number): Promise<string | null> {
    const video = await this.getVideoById(videoId);
    if (!video || !video.runwayGeneratedImages || !video.runwayGeneratedImages[runwayOutputIndex]) {
      console.warn(`[getRunwayOutputImagePath] RunwayML output image not found: videoId=${videoId}, index=${runwayOutputIndex}`);
      return null;
    }
    const path = video.runwayGeneratedImages[runwayOutputIndex].runwayOutputImagePath;
    if (path) {
      return path;
    }
    return null;
  }


  // --- Helper Functions for Internal Processing ---

  private async getVideoDuration(filePath: string): Promise<number> {
    try {
      const command = `${ffprobePath} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
      const { stdout, stderr } = await execAsync(command);
      if (stderr) {
        console.warn(`ffprobe stderr (duration): ${stderr}`);
      }
      const duration = parseFloat(stdout.trim());
      if (isNaN(duration) || duration <= 0) {
        throw new Error("Could not parse valid duration from ffprobe or duration is zero.");
      }
      return duration; // Duration is in seconds
    } catch (error: any) {
      console.error("Error getting video duration with ffprobe:", error.message);
      throw new Error(`Failed to get video duration: ${error.message}`);
    }
  }

  // extractSingleFrame now takes timestampSeconds as input
  private async extractSingleFrame(videoPath: string, timestampSeconds: number, outputPath: string): Promise<void> {
    const seekTime = Math.max(0, timestampSeconds); // Ensure timestamp is not negative

    // --- CHANGE START: More robust FFmpeg command for frame extraction ---
    // -map 0:v:0 ensures only the video stream is used (important for some files)
    // -frames:v 1 is preferred over -vframes 1 (more explicit)
    // -c:v mjpeg (or -c:v png) explicitly sets the output codec, often helps with problematic inputs
    // -f image2 is redundant if you specify output file type, but can help explicitly
    // -q:v 2 or -q:v 1 (higher quality) is fine, or remove for default quality.
    const command = `${ffmpegPath} -ss ${seekTime.toFixed(3)} -i "${videoPath}" -frames:v 1 -map 0:v:0 -c:v mjpeg -q:v 2 -y "${outputPath}"`;
    // --- CHANGE END ---

    try {
      await execAsync(command);
    } catch (error: any) {
      console.error(`Error extracting frame from ${videoPath} at ${timestampSeconds}s to ${outputPath}:`, error.stderr || error.message);
      throw error;
    }
  }

  // --- Main Asynchronous Video Processing Logic ---

  async processVideo(videoId: string) {
    let video: VideoDocument | null = null;
    const tempWorkingDirsToClean: string[] = [];

    try {
      const foundVideo = await this.getVideoById(videoId);
      if (!foundVideo) {
        console.error('Video not found for processing:', videoId);
        return;
      }
      video = foundVideo;

      if (!video.localFilePath) {
        console.error(`Video ${videoId} has no local file path. Skipping processing.`);
        video.status = 'FAILED';
        video.processingError = 'No local file path found for video.';
        await video.save();
        return;
      }

      video.status = 'PROCESSING';
      await video.save();
      console.log(`\n--- Starting initial video processing: "${video.originalFileName}" (DB ID: ${(video._id as Types.ObjectId).toString()}) ---`);

      const movieDurationSeconds = await this.getVideoDuration(video.localFilePath); // Duration in seconds
      if (movieDurationSeconds === 0) {
        throw new Error('Video duration could not be determined or is zero.');
      }
      console.log(`   Movie duration: ${movieDurationSeconds.toFixed(2)} seconds`);
      const movieDurationMilliseconds = movieDurationSeconds * 1000; // Convert to milliseconds for validation

      // 1. Read the entire video file into a Buffer
      console.log(`1. Reading entire video file into memory...`);
      const videoBuffer: Buffer = await fsPromises.readFile(video.localFilePath);
      console.log(`   Video file loaded. Size: ${(videoBuffer.length / (1024 * 1024)).toFixed(2)} MB`);

      // --- CHANGE START: Ensure correct MIME type for Gemini API ---
      // Use 'video/mp4' explicitly if the video is guaranteed to be MP4,
      // or derive it more robustly if it's from a different format (e.g., using 'file-type' package)
      const mimeType: string = 'video/mp4'; // Forcing to video/mp4 as per previous Gemini error
      // --- CHANGE END ---

      // 2. Call Gemini API with the entire video
      const identifiedScenesFromGemini: IdentifiedSceneSubdocument[] = [];
      if (!this.geminiModel) { // Check class property
        throw new InternalServerErrorException("Gemini model not initialized. Check API key.");
      }
      console.log('2. Analyzing entire video with Gemini API...');

      const videoPart: Part = {
        inlineData: {
          data: videoBuffer.toString('base64'),
          mimeType: mimeType
        }
      };

      const prompt: string = `Analyze this entire movie video, considering the user's overall interest: "${video.userPrompt}".
      Identify scenes that are visually compelling or emotionally engaging for a single ad image/thumbnail.
      For each identified scene, provide a description and its precise TIMESTAMP *relative to the beginning of the entire video* IN MILLISECONDS.
      Ensure timestamps are integers. List up to 10 best scenes.

      Respond for each scene in the format:
      Scene 1:
      Description: [brief description]
      Timestamp: [absolute timestamp in milliseconds]
      Reason: [brief reason]

      Scene 2:
      ...

      If no scenes found, respond with: "No scenes found."`;

      try {
        const result = await this.geminiModel.generateContent([prompt, videoPart]); // Use class property
        const responseText = result.response.text();
        console.log(`   Gemini API response (partial):`, responseText.substring(0, Math.min(responseText.length, 500)) + (responseText.length > 500 ? '...' : ''));

        if (responseText && !responseText.includes("No scenes found.")) {
          const sceneMatches = responseText.match(/Scene \d+:\nDescription: (.*?)\nTimestamp: (\d+(?:\.\d+)?)\nReason: (.*)/g);

          if (sceneMatches) {
            sceneMatches.forEach(match => {
              const descMatch = match.match(/Description: (.*)/);
              const timestampMatch = match.match(/Timestamp: (\d+(?:\.\d+)?)/);

              if (descMatch && timestampMatch) {
                let timestampStr = timestampMatch[1];
                let timestamp: number;

                timestamp = parseFloat(timestampStr);

                if (!isNaN(timestamp) && timestamp >= 0 && timestamp <= movieDurationMilliseconds) {
                  identifiedScenesFromGemini.push({ description: descMatch[1].trim(), timestamp: timestamp });
                } else {
                  console.warn(`   Gemini suggested invalid timestamp: '${timestampStr}' (parsed to ${timestamp}ms, outside 0-${movieDurationMilliseconds}ms). Skipping.`);
                }
              }
            });
          }
        }
      } catch (apiError: any) {
        if (apiError.response && apiError.response.error) {
          console.error(`   Gemini API Error Response:`, apiError.response.error);
        } else {
          console.error(`   Error calling Gemini API:`, apiError.message);
        }
        throw new InternalServerErrorException(`Gemini API call failed: ${apiError.message}`);
      }

      // 3. Select the best 10 scenes from Gemini's suggestions
      const finalIdentifiedScenes = identifiedScenesFromGemini.slice(0, 10);
      console.log(`   Selected ${finalIdentifiedScenes.length} scenes for frame extraction.`);

      // 4. Extract 3 frames per identified scene and store paths
      const extractedFramesOutputDir = path.join(process.cwd(), 'output_frames', `${(video._id as Types.ObjectId).toString()}`);
      // REMOVED: tempWorkingDirsToClean.push(extractedFramesOutputDir); // DO NOT CLEAN UP FINAL OUTPUT DIRECTORY
      await fsPromises.mkdir(extractedFramesOutputDir, { recursive: true });
      console.log(`4. Extracting 3 frames for each selected scene to ${extractedFramesOutputDir}...`);

      const scenesWithFramesForDB: IdentifiedSceneSubdocument[] = [];

      for (let i = 0; i < finalIdentifiedScenes.length; i++) {
        const scene = finalIdentifiedScenes[i];
        const baseTimestampMilliseconds = scene.timestamp; // Timestamp is now in milliseconds

        // Convert milliseconds to seconds for ffmpeg
        const frameTimestampsSeconds = [
          Math.max(0, (baseTimestampMilliseconds - 500) / 1000), // -500ms
          baseTimestampMilliseconds / 1000,                       // exact timestamp
          Math.min(movieDurationSeconds, (baseTimestampMilliseconds + 500) / 1000) // +500ms
        ];

        const currentSceneFramePaths: string[] = [];

        const frameExtractionPromises = frameTimestampsSeconds.map(async (ts, j) => { // Use ts for seconds
          const frameType = ['before', 'at', 'after'][j];
          // Use toFixed(3) for filename to include milliseconds if needed
          const frameFileName = `scene_${i}_${frameType}_${ts.toFixed(3).replace('.', '_')}.jpeg`; // Replaced dot with underscore for filename safety
          const frameOutputPath = path.join(extractedFramesOutputDir, frameFileName);

          try {
            await this.extractSingleFrame(video!.localFilePath, ts, frameOutputPath); // ffmpeg expects seconds
            return frameOutputPath;
          } catch (frameError: any) {
            console.error(`   Failed to extract ${frameType} frame for scene ${i} at ${ts}s:`, frameError.message);
            return ''; // Return empty string on failure
          }
        });

        const extractedPaths = await Promise.all(frameExtractionPromises);
        currentSceneFramePaths.push(...extractedPaths.filter(p => p !== '')); // Only add successful paths

        // Add the collected scene data with its extracted frame paths for DB save
        scenesWithFramesForDB.push({
          timestamp: scene.timestamp, // Keep timestamp in milliseconds for DB
          description: scene.description,
          frameLocalPaths: currentSceneFramePaths,
        });
      }

      // 5. Update video document with final scenes (including frame paths)
      video.set('identifiedScenes', scenesWithFramesForDB);
      video.status = 'COMPLETED'; // Initial processing completed
      console.log('   Initial video processing complete.');

    } catch (error: any) {
      console.error('--- CRITICAL ERROR during initial video processing:', error);
      if (video) {
        video.status = 'FAILED';
        video.processingError = error instanceof Error ? error.message : 'Unknown error during initial processing.';
        console.error(`Error details saved to video ${video._id}: ${video.processingError}`);
      }
    } finally {
      // 6. Cleanup of temporary working directories (ONLY TEMP, NOT FINAL OUTPUT)
      console.log('5. Cleanup: Cleaning up temporary working directories...');
      for (const p of tempWorkingDirsToClean) {
        try {
          const stats = await fsPromises.stat(p);
          if (stats.isDirectory()) {
            await fsPromises.rm(p, { recursive: true, force: true });
            console.log(`   Cleaned up temp directory: ${p}`);
          } else {
            await fsPromises.unlink(p);
            console.log(`   Cleaned up temp file: ${p}`);
          }
        } catch (err: any) {
          console.warn(`   Could not delete temporary item ${p}:`, err.message);
        }
      }

      if (video) {
        await video.save();
        console.log(`\n--- Initial video processing finished for "${video.originalFileName}". Final status: ${video.status} ---`);
      } else {
        console.warn("Video object was null before initial processing began. Status not updated in DB.");
      }
    }
  }

  // --- NEW: RunwayML Integration Method (Phase 2) ---

  /**
   * Processes a specific app-generated video frame with RunwayML based on user input.
   * This method is called asynchronously after a user selects a frame.
   * @param videoId The ID of the video the frame belongs to.
   * @param sceneIndex The index of the identified scene from which the frame was selected.
   * @param frameIndex The index of the specific frame within the scene (0, 1, or 2).
   * @param userRunwayPrompt The mandatory text prompt from the user for RunwayML.
   * @param userInputImagePath Optional: The absolute path to a user-provided image (input to RunwayML).
   * @returns The updated VideoDocument.
   */
  async processFrameWithRunway(
    videoId: string,
    sceneIndex: number,
    frameIndex: number,
    userRunwayPrompt: string,
    userInputImagePath?: string
  ): Promise<VideoDocument> {
    let video: VideoDocument | null = null;
    let runwayOutputLocalPath: string | undefined;

    try {
      // Check if clients are initialized
      if (!this.runwayClient) {
        throw new InternalServerErrorException('RunwayML client is not initialized. Check RUNWAYML_API_KEY environment variable.');
      }
      if (!runwayModelId) {
        throw new InternalServerErrorException('RUNWAYML_MODEL_ID environment variable is not set for RunwayML processing.');
      }

      const foundVideo = await this.getVideoById(videoId);
      if (!foundVideo) {
        throw new NotFoundException(`Video with ID ${videoId} not found for RunwayML processing.`);
      }
      video = foundVideo;

      // Validate inputs for frame selection
      if (!video.identifiedScenes || !video.identifiedScenes[sceneIndex] || !video.identifiedScenes[sceneIndex].frameLocalPaths || frameIndex < 0 || frameIndex > 2) {
        throw new BadRequestException('Invalid scene or frame index provided for RunwayML processing.');
      }
      if (!userRunwayPrompt || userRunwayPrompt.trim() === '') {
        throw new BadRequestException('Text prompt for RunwayML is required.');
      }

      const selectedFrameLocalPath = video.identifiedScenes[sceneIndex].frameLocalPaths[frameIndex];
      if (!selectedFrameLocalPath) {
        throw new NotFoundException('Selected frame file path is empty or invalid in DB.');
      }
      // Ensure the file physically exists on disk before attempting to serve/process
      try {
        await fsPromises.access(selectedFrameLocalPath);
      } catch (e) {
        throw new NotFoundException(`Selected frame file not found on disk at: ${selectedFrameLocalPath}`);
      }

      // 1. Update video status to indicate RunwayML processing is pending
      video.status = 'RUNWAY_PENDING';
      await video.save();
      console.log(`\n--- Starting RunwayML processing for frame: "${selectedFrameLocalPath}" (Video ID: ${videoId}) ---`);

      // 2. Construct public URL for the selected local frame
      const framePublicUrl = `${BASE_URL}/video/frame/${videoId}/${sceneIndex}/${frameIndex}`;
      console.log(`   Reference frame URL for RunwayML: ${framePublicUrl}`);

      // 3. Prepare RunwayML API Payload
      const runwayPayload: any = {
        model: runwayModelId,
        ratio: '1920:1080', // Default output ratio
        promptText: userRunwayPrompt,
        referenceImages: [
          {
            uri: framePublicUrl, // Use the public URL to the selected frame
            tag: 'ReferenceFrame',
          },
        ],
      };

      // Add user-provided input image if available (assuming it's also served via a public URL)
      if (userInputImagePath) {
        const userInputImagePublicUrl = `${BASE_URL}/user-uploads/${path.basename(userInputImagePath)}`; // Placeholder
        runwayPayload.referenceImages.push({
          uri: userInputImagePublicUrl,
          tag: 'UserInputImage',
        });
        console.warn(`   User input image path provided: ${userInputImagePath}. Assumed public URL: ${userInputImagePublicUrl}.`);
      }

      console.log("runwayPayload",runwayPayload);

      // 4. Call RunwayML API
      console.log('   Calling RunwayML API...');
      let runwayTask: any;
      try {
        runwayTask = await this.runwayClient.textToImage.create(runwayPayload); // <-- Use this.runwayClient
        console.log(`   RunwayML task created with ID: ${runwayTask.id}`);
      } catch (runwayCreateError: any) {
        console.error(`Error creating RunwayML task:`, runwayCreateError.message, runwayCreateError.details);
        throw new InternalServerErrorException(`Failed to create RunwayML task: ${runwayCreateError.message}`);
      }

      // 5. Poll RunwayML task status
      do {
        await new Promise(resolve => setTimeout(resolve, 3000)); // Poll every 3 seconds
        runwayTask = await this.runwayClient!.tasks.retrieve(runwayTask.id); // <-- Use this.runwayClient!
        console.log(`   RunwayML task ${runwayTask.id} status: ${runwayTask.status}`);
      } while (!['SUCCEEDED', 'FAILED', 'CANCELED'].includes(runwayTask.status));

      if (runwayTask.status === 'FAILED' || runwayTask.status === 'CANCELED') {
        throw new Error(`RunwayML task failed or was canceled. Status: ${runwayTask.status}, Errors: ${JSON.stringify(runwayTask.error || 'N/A')}`);
      }

      // 6. Process RunwayML response and download image
      if (!runwayTask.output || runwayTask.output.length === 0 || !runwayTask.output[0]) {
        throw new Error('RunwayML task succeeded but returned no output image URL.');
      }
      const runwayOutputImageUrl = runwayTask.output[0];
      console.log(`   RunwayML output image URL: ${runwayOutputImageUrl}`);

      // Download the image from RunwayML's URL
      const response = await fetch(runwayOutputImageUrl);
      if (!response.ok) {
        throw new Error(`Failed to download image from RunwayML URL: ${response.statusText}`);
      }
      const outputImageBuffer = Buffer.from(await response.arrayBuffer());

      // 7. Save RunwayML output image to local disk
      const outputExtension = runwayOutputImageUrl.split('.').pop()?.toLowerCase() || 'png';
      const runwayVideoOutputDir = path.join(RUNWAY_OUTPUT_DIR, (video._id as Types.ObjectId).toString());
      await fsPromises.mkdir(runwayVideoOutputDir, { recursive: true });

      const outputFileName = `runway_output_${Date.now()}.${outputExtension}`;
      runwayOutputLocalPath = path.join(runwayVideoOutputDir, outputFileName);
      await fsPromises.writeFile(runwayOutputLocalPath, outputImageBuffer);
      console.log(`   RunwayML output image saved to: ${runwayOutputLocalPath}`);

      // 8. Update video document with RunwayML output path
      const newRunwayImageRecord: RunwayOutputImageSubdocument = {
        originalVideoFramePath: selectedFrameLocalPath,
        userTextInput: userRunwayPrompt,
        userInputImagePath: userInputImagePath,
        runwayOutputImagePath: runwayOutputLocalPath,
        processedAt: new Date(),
      };

      video.runwayGeneratedImages.push(newRunwayImageRecord); // Push to the array on the Video document
      video.status = 'RUNWAY_COMPLETED';
      console.log('   RunwayML processing complete and saved to DB.');

      return video; // Return the updated video document

    } catch (error: any) {
      console.error('--- CRITICAL ERROR during RunwayML processing:', error);
      if (video) {
        video.status = 'RUNWAY_FAILED';
        video.processingError = error instanceof Error ? error.message : 'An unknown error occurred during RunwayML processing.';
        console.error(`Error details saved to video ${video._id}: ${video.processingError}`);
      }
      if (error instanceof NotFoundException || error instanceof BadRequestException || error instanceof InternalServerErrorException) {
        throw error; // Re-throw NestJS exceptions for proper HTTP response
      }
      throw new InternalServerErrorException(error.message || 'An unknown error occurred during RunwayML processing.'); // Wrap other errors
    } finally {
      if (video) {
        await video.save(); // Save final status (RUNWAY_COMPLETED/FAILED) to MongoDB
        console.log(`\n--- RunwayML processing finished for "${video.originalFileName}". Final status: ${video.status} ---`);
      } else {
        console.warn("Video object was null before RunwayML processing began. Status not updated in DB.");
      }
    }
  }
}