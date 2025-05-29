// src/app.module.ts
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MongooseModule } from '@nestjs/mongoose';
import { VideoModule } from './video/video.module';
import { ConfigModule } from '@nestjs/config'; // <--- ADD THIS IMPORT

@Module({
  imports: [
    ConfigModule.forRoot({ // <--- ADD THIS CONFIGURATION
      isGlobal: true, // Makes ConfigModule available throughout your app
      envFilePath: '.env', // Specifies the path to your .env file
    }),
    MongooseModule.forRoot('mongodb://localhost:27017/video_ads_db'), // Your MongoDB connection string
    VideoModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}