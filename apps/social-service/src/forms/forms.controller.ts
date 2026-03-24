import { Body, Controller, Get, Param, Post, Res, Query } from '@nestjs/common';
import { Response } from 'express';
import { CreateFormDto, SubmitFormDto } from './dto/form.dto';
import { FormsService } from './forms.service';

@Controller('forms')
export class FormsController {
  constructor(private readonly service: FormsService) {}

  @Post()
  create(@Body() dto: CreateFormDto) {
    return this.service.create(dto);
  }

  @Get()
  list(@Query('ownerId') ownerId?: string) {
    return this.service.list(ownerId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Get(':id/submission')
  async getSubmission(@Param('id') id: string, @Query('userId') userId: string) {
    if (!userId) {
      throw new Error('UserId is required');
    }
    return this.service.getSubmission(id, userId);
  }

  @Get(':id/check')
  async checkSubmission(@Param('id') id: string, @Query('userId') userId: string) {
    const hasSubmitted = await this.service.hasSubmission(id, userId);
    return { hasSubmitted };
  }

  @Post(':id/submit')
  submit(@Param('id') id: string, @Body() dto: SubmitFormDto) {
    return this.service.submit(id, dto);
  }

  @Get(':id/submissions')
  getSubmissions(@Param('id') id: string) {
    return this.service.getSubmissions(id);
  }

  @Get(':id/export')
  async export(@Param('id') id: string, @Res() res: Response) {
    const buffer = await this.service.exportSubmissions(id);

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="submissions_${id}.xlsx"`,
      'Content-Length': buffer.byteLength,
    });

    res.send(Buffer.from(buffer));
  }
}
