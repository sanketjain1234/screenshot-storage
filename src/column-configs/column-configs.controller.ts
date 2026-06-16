import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ColumnConfigsService } from './column-configs.service';
import {
  AvailableColumnsResponseDto,
  ColumnConfigResponseDto,
  CreateColumnConfigDto,
  UpdateColumnConfigDto,
  buildAvailableColumnsResponse,
} from './dto/column-config.dto';

@ApiTags('Column Configs')
@Controller('column-configs')
export class ColumnConfigsController {
  constructor(private readonly service: ColumnConfigsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new column configuration' })
  @ApiResponse({ status: 201, description: 'Config created', type: ColumnConfigResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error' })
  create(@Body() dto: CreateColumnConfigDto): ColumnConfigResponseDto {
    return this.service.create(dto);
  }

  @Get('available')
  @ApiOperation({
    summary: 'List all supported column keys with their labels and Gemini instructions',
    description: 'Use this to discover what column keys can be passed to POST /column-configs.',
  })
  @ApiResponse({ status: 200, type: AvailableColumnsResponseDto })
  getAvailable(): AvailableColumnsResponseDto {
    return buildAvailableColumnsResponse();
  }

  @Get()
  @ApiOperation({ summary: 'List all saved column configurations' })
  @ApiResponse({ status: 200, type: [ColumnConfigResponseDto] })
  findAll(): ColumnConfigResponseDto[] {
    return this.service.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a column configuration by ID' })
  @ApiParam({ name: 'id', description: 'Column config UUID' })
  @ApiResponse({ status: 200, type: ColumnConfigResponseDto })
  @ApiResponse({ status: 404, description: 'Config not found' })
  findOne(@Param('id') id: string): ColumnConfigResponseDto {
    return this.service.findById(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a column configuration' })
  @ApiParam({ name: 'id', description: 'Column config UUID' })
  @ApiResponse({ status: 200, type: ColumnConfigResponseDto })
  @ApiResponse({ status: 404, description: 'Config not found' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateColumnConfigDto,
  ): ColumnConfigResponseDto {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a column configuration' })
  @ApiParam({ name: 'id', description: 'Column config UUID' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 404, description: 'Config not found' })
  remove(@Param('id') id: string): void {
    this.service.delete(id);
  }
}
