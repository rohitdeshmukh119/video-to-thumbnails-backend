// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv'; // <--- ADD THIS LINE

dotenv.config(); // <--- ADD THIS LINE: Load .env variables right at the start

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Your other app configurations here (e.g., global prefix, validation pipe)

  // --- CRITICAL FIX FOR CORS ---
  app.enableCors({
    origin: 'http://localhost:5174', // <--- IMPORTANT: This MUST match your frontend's URL exactly!
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], // Allowed HTTP methods
    allowedHeaders: ['Content-Type', 'Authorization'], // Allowed headers
    credentials: true, // Allow cookies/auth headers if your frontend needs them
  });
  // --- END CORS FIX ---


  await app.listen(3000);
  console.log(`Application is running on: ${await app.getUrl()}`);
}
bootstrap();