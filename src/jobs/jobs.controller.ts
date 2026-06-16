import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { JobsService } from './jobs.service';
import { JobResponseDto } from './dto/job-response.dto';
import { UploadJobDto } from './dto/upload-job.dto';
import { UrlJobDto } from './dto/url-job.dto';

class UploadVideoSwaggerDto {
  @ApiProperty({ type: 'string', format: 'binary', description: 'Video file (mp4, mov, webm, avi). Max 200MB, max 3 minutes.' })
  video: Express.Multer.File;

  @ApiPropertyOptional({ description: 'ID of a saved ColumnConfig for custom columns.' })
  configId?: string;
}

@ApiTags('Jobs')
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Post('upload')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FileInterceptor('video', {
      storage: diskStorage({
        destination: process.env.TEMP_DIR ?? '/tmp',
        filename: (_req, file, cb) =>
          cb(null, `${uuidv4()}${extname(file.originalname)}`),
      }),
      limits: { fileSize: Number(process.env.MAX_FILE_SIZE_BYTES) || 209715200 },
      fileFilter: (_req, file, cb) => {
        const allowed = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo'];
        if (allowed.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new Error(`Unsupported file type: ${file.mimetype}`), false);
        }
      },
    }),
  )
  @ApiOperation({ summary: 'Upload a video file for async processing' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadVideoSwaggerDto })
  @ApiResponse({ status: 202, description: 'Job accepted', type: JobResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid file type' })
  @ApiResponse({ status: 422, description: 'Video too long or invalid format' })
  async uploadVideo(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: UploadJobDto,
  ): Promise<JobResponseDto> {
    return this.jobsService.createFromFile(file, body.configId);
  }

  @Post('from-url')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Submit a public video URL for async processing' })
  @ApiBody({ type: UrlJobDto })
  @ApiResponse({ status: 202, description: 'Job accepted', type: JobResponseDto })
  @ApiResponse({ status: 400, description: 'URL not whitelisted or invalid' })
  @ApiResponse({ status: 422, description: 'Video too long, too large, or invalid format' })
  async fromUrl(@Body() dto: UrlJobDto): Promise<JobResponseDto> {
    return this.jobsService.createFromUrl(dto.url, dto.configId);
  }

  @Get(':jobId')
  @ApiOperation({ summary: 'Poll job status. Returns full result when COMPLETED.' })
  @ApiParam({ name: 'jobId', description: 'UUID returned from upload or from-url endpoints' })
  @ApiResponse({ status: 200, type: JobResponseDto })
  @ApiResponse({ status: 404, description: 'Job not found' })
  getJob(@Param('jobId') jobId: string): JobResponseDto {
    return this.jobsService.findById(jobId);
  }
}
