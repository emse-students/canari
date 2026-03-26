import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Res,
  Query,
  NotFoundException,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { CreateFormDto, SubmitFormDto } from './dto/form.dto';
import { FormsService } from './forms.service';

@Controller('forms')
export class FormsController {
  constructor(private readonly service: FormsService) {}

  @UseGuards(NginxAuthGuard)
  @Post()
  create(@Headers('x-user-id') xUserId: string, @Body() dto: CreateFormDto) {
    return this.service.create({ ...dto, ownerId: xUserId });
  }

  @UseGuards(NginxAuthGuard)
  @Get()
  list(@Headers('x-user-id') xUserId: string) {
    return this.service.list(xUserId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @UseGuards(NginxAuthGuard)
  @Get(':id/submission')
  async getSubmission(@Param('id') id: string, @Headers('x-user-id') xUserId: string) {
    return this.service.getSubmission(id, xUserId);
  }

  @UseGuards(NginxAuthGuard)
  @Get(':id/check')
  async checkSubmission(@Param('id') id: string, @Headers('x-user-id') xUserId: string) {
    const hasSubmitted = await this.service.hasSubmission(id, xUserId);
    return { hasSubmitted };
  }

  @UseGuards(NginxAuthGuard)
  @Post(':id/submit')
  submit(
    @Headers('x-user-id') xUserId: string,
    @Param('id') id: string,
    @Body() dto: SubmitFormDto
  ) {
    return this.service.submit(id, { ...dto, userId: xUserId });
  }

  @Get(':id/submissions')
  getSubmissions(@Param('id') id: string) {
    return this.service.getSubmissions(id);
  }

  @Get(':id/export')
  async export(@Param('id') id: string, @Res() res: Response) {
    const buffer = await this.service.exportSubmissions(id);

    const form = await this.service.get(id);
    if (!form) throw new NotFoundException('Form not found');
    const filename = form.title.replace(/[^a-zA-Z0-9]/g, '');

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}.xlsx"`,
      'Content-Length': buffer.byteLength,
    });

    res.send(Buffer.from(buffer));
  }
}
