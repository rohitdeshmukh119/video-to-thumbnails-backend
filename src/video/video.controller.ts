// src/video/video.controller.ts
import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Res,
  UseInterceptors,
  UploadedFile,
  NotFoundException,
  InternalServerErrorException,
  BadRequestException
} from '@nestjs/common';
import { VideoService } from './video.service';
import { VideoDocument } from './schemas/video.schema'; // Import VideoDocument for type hinting
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express'; // Import Response from express for @Res()
import * as fs from 'fs'; // Use regular fs for synchronous existsSync at startup
import * as fsPromises from 'fs/promises'; // Use fs/promises for async operations like access
import * as path from 'path';

// Define the UPLOAD_DIR constant if not already defined globally or in a config file
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
// Ensure the upload directory exists when the app starts
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

@Controller('video')
export class VideoController {
  constructor(private readonly videoService: VideoService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('video')) // Intercepts the 'video' field from multipart form data
  async uploadVideo(
    @UploadedFile() file: Express.Multer.File, // Decorator to extract the uploaded file
    @Body('prompt') prompt: string, // Decorator to extract the 'prompt' field from the form body
  ): Promise<{ message: string; video: { id: any; originalFileName: string; prompt: string; status: string; localFilePath: string; } }> { // Adjusted return type
    if (!file) {
      throw new BadRequestException('Video file is required.');
    }
    if (!prompt) {
      // Use fsPromises.unlink for async deletion
      await fsPromises.unlink(file.path).catch(err => console.error('Error deleting temp upload file:', err));
      throw new BadRequestException('User prompt is required.');
    }
    const videoMetadata = await this.videoService.saveVideoMetadata(file, prompt);

    console.log(`Video uploaded: ${file.originalname}, stored at: ${file.path}`); // file.path might be undefined for memory storage
    console.log(`User prompt: ${prompt}`);

    return {
      message: 'Video uploaded and processing initiated (check status endpoint for results)',
      video: {
        id: videoMetadata._id, // MongoDB ObjectId will be cast to string automatically in JSON response
        originalFileName: videoMetadata.originalFileName,
        prompt: videoMetadata.userPrompt,
        status: videoMetadata.status,
        localFilePath: videoMetadata.localFilePath, // This is included based on the type definition you provided
      },
    };
  }

  @Get('status/:videoId')
  // Adjusted return type to match the object returned, not the full VideoDocument
  async getStatus(@Param('videoId') videoId: string): Promise<{ id: any; status: string; identifiedScenes: any[]; }> {
    const video = await this.videoService.getVideoById(videoId);
    if (!video) {
      throw new NotFoundException('Video not found.'); // Changed to NotFoundException for GET requests
    }
    return {
      id: video._id,
      status: video.status,
      identifiedScenes: video.identifiedScenes, // This will be an array of {timestamp, description, frameLocalPaths}
    };
  }

  @Get('frame/:videoId/:sceneIndex/:frameIndex')
  async getFrame(
    @Param('videoId') videoId: string,
    @Param('sceneIndex') sceneIndex: number,
    @Param('frameIndex') frameIndex: number,
    @Res() res: Response // Direct access to the Express response object for file serving
  ) {
    try {
      const framePath = await this.videoService.getSpecificFramePath(
        videoId,
        Number(sceneIndex),
        Number(frameIndex)
      );

      if (!framePath) {
        throw new NotFoundException('Frame not found, invalid indices, or processing not complete.');
      }

      // Check if file exists on disk before attempting to send
      try {
        await fsPromises.access(framePath); // Use fsPromises.access for async access check
      } catch (error) {
        throw new NotFoundException('Frame file not found on server disk.');
      }

      // Send the file as a response
      res.sendFile(framePath, (err: NodeJS.ErrnoException) => {
        if (err) {
          console.error(`Error serving frame file ${framePath}:`, err);
          // --- FIXED: Check if headers already sent before sending new response ---
          if (!res.headersSent) {
            if (err.code === 'ENOENT') {
              res.status(404).send('Frame file not found on server.');
            } else {
              res.status(500).send('Error serving frame file.');
            }
          }
        }
      });
    } catch (error) {
      console.error('Error in getFrame controller:', error);
      // --- FIXED: Check if headers already sent before throwing ---
      if (!res.headersSent) {
        throw new InternalServerErrorException(error.message || 'An unknown error occurred while serving frame.');
      }
    }
  }

  // --- NEW API: Trigger RunwayML Integration ---
  // Endpoint: POST /video/runway-process/:videoId/:sceneIndex/:frameIndex
  @Post('runway-process/:videoId/:sceneIndex/:frameIndex')
  // 'userImage' is the field name for the optional image upload in multipart form data
  @UseInterceptors(FileInterceptor('userImage'))
  async processFrameWithRunway(
    @Param('videoId') videoId: string,
    @Param('sceneIndex') sceneIndex: number,
    @Param('frameIndex') frameIndex: number,
    @UploadedFile() userImage: Express.Multer.File, // Optional user image file
    @Body('userTextInput') userTextInput: string, // Mandatory user text input from form body
  ): Promise<{ message: string; videoId: string; status: string }> { // Return immediate feedback
    console.log(`[Controller Debug] Received RunwayML request for videoId: ${videoId}, scene: ${sceneIndex}, frame: ${frameIndex}`);
    if (!userTextInput || userTextInput.trim() === '') {
      // If prompt is missing, and userImage was uploaded, delete it.
      if (userImage) {
        await fsPromises.unlink(userImage.path).catch(err => console.error('Error deleting temp upload file:', err));
      }
      throw new BadRequestException('User text input is mandatory for RunwayML processing.');
    }

    try {
      // This part ensures the video and frame exist before triggering the background job
      const video = await this.videoService.getVideoById(videoId);
      if (!video) {
        throw new NotFoundException(`Video with ID ${videoId} not found.`);
      }
      const appGeneratedFramePath = await this.videoService.getSpecificFramePath(videoId, Number(sceneIndex), Number(frameIndex));
      if (!appGeneratedFramePath) {
        throw new NotFoundException('The specified app-generated video frame was not found or not yet processed.');
      }

      // --- Important: Trigger background processing and return immediate response ---
      // Call the service method to handle RunwayML processing.
      // This call is intentionally NOT awaited here, allowing the HTTP response to be sent immediately.
      this.videoService.processFrameWithRunway(
        videoId,
        Number(sceneIndex),
        Number(frameIndex),
        userTextInput,
        userImage ? userImage.path : undefined // Pass local path of user-uploaded image
      ).catch(err => console.error(`Background RunwayML processing failed for video ${videoId}:`, err)); // Log any errors from background process

      // Return immediate response to the client
      return {
        message: 'RunwayML image processing initiated. Please check status endpoint for updates.',
        videoId: videoId,
        status: 'RUNWAY_PENDING' // Inform the client of the initial status
      };

    } catch (error) {
      console.error('Error in processFrameWithRunway controller:', error);
      // If error occurred during validation or setup, delete userImage if uploaded
      if (userImage) {
        await fsPromises.unlink(userImage.path).catch(err => console.error('Error deleting user uploaded image:', err));
      }
      throw new InternalServerErrorException(error.message || 'An unknown error occurred during RunwayML processing initiation.');
    }
  }

  // --- NEW API: Retrieve RunwayML generated image ---
  // Endpoint: GET /video/runway-output/:videoId/:runwayOutputIndex
  @Get('runway-output/:videoId/:runwayOutputIndex')
  async getRunwayOutputImage(
    @Param('videoId') videoId: string,
    @Param('runwayOutputIndex') runwayOutputIndex: number,
    @Res() res: Response // Direct access to the Express response object for file serving
  ) {
    try {
      const imagePath = await this.videoService.getRunwayOutputImagePath(videoId, Number(runwayOutputIndex));

      if (!imagePath) {
        throw new NotFoundException('RunwayML output image not found or processing not complete.');
      }

      // Check if file exists on disk before attempting to send
      try {
        await fsPromises.access(imagePath); // Use fsPromises.access for async access check
      } catch (error) {
        throw new NotFoundException('RunwayML output image file not found on server disk.');
      }

      // Send the file as a response
      res.sendFile(imagePath, (err: NodeJS.ErrnoException) => {
        if (err) {
          console.error(`Error serving RunwayML output image ${imagePath}:`, err);
          // --- FIXED: Check if headers already sent before sending new response ---
          if (!res.headersSent) {
            if (err.code === 'ENOENT') {
              res.status(404).send('RunwayML output image file not found on server.');
            } else {
              res.status(500).send('Error serving RunwayML output image.');
            }
          }
        }
      });
    } catch (error) {
      console.error('Error in getRunwayOutputImage controller:', error);
      // --- FIXED: Check if headers already sent before throwing ---
      if (!res.headersSent) {
        throw new InternalServerErrorException(error.message || 'An unknown error occurred while serving RunwayML output image.');
      }
    }
  }
}