// src/video/video.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VideoController } from './video.controller';
import { VideoService } from './video.service';
import { Video, VideoSchema } from './schemas/video.schema'; // Correct import for the updated schema
import { MulterModule } from '@nestjs/platform-express';
import * as path from 'path';
import * as fs from 'fs'; // Import fs module for creating directory

// Define the directory where uploaded videos will be stored
// This will create an 'uploads' folder in your project's root directory
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');

// Ensure the upload directory exists when the application starts
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

@Module({
  imports: [
    // Register the Video schema with MongooseModule for database interaction
    MongooseModule.forFeature([{ name: Video.name, schema: VideoSchema }]),

    // Configure Multer to save uploaded files to the local disk
    MulterModule.register({
      dest: UPLOAD_DIR, // Specify the destination directory for uploaded files
      limits: {
        fileSize: 500 * 1024 * 1024, // Set maximum file size to 500 MB (in bytes)
      },
    }),
  ],
  controllers: [VideoController], // Declare VideoController to handle HTTP requests
  providers: [VideoService],     // Declare VideoService to provide business logic
  exports: [VideoService]       // Export VideoService if it's used by other modules (e.g., background job queues)
})
export class VideoModule {}