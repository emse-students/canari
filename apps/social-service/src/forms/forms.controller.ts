import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Res,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { CreateFormDto, SubmitFormDto } from './dto/form.dto';
import { FormsService } from './forms.service';

/** Manages form resources including submissions, payment status, and XLSX exports. */
@Controller('forms')
export class FormsController {
  constructor(private readonly service: FormsService) {}

  /** Creates a new form owned by the calling user. */
  @UseGuards(NginxAuthGuard)
  @Post()
  create(@Headers('x-user-id') xUserId: string, @Body() dto: CreateFormDto) {
    return this.service.create({ ...dto, ownerId: xUserId });
  }

  /** Returns all forms owned by the calling user. */
  @UseGuards(NginxAuthGuard)
  @Get()
  list(@Headers('x-user-id') xUserId: string) {
    return this.service.list(xUserId);
  }

  /** Returns a single form by its ID. */
  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  /** Returns the calling user's submission for a specific form. */
  @UseGuards(NginxAuthGuard)
  @Get(':id/submission')
  async getSubmission(@Param('id') id: string, @Headers('x-user-id') xUserId: string) {
    return this.service.getSubmission(id, xUserId);
  }

  /** Returns whether the calling user has already submitted the specified form. */
  @UseGuards(NginxAuthGuard)
  @Get(':id/check')
  async checkSubmission(@Param('id') id: string, @Headers('x-user-id') xUserId: string) {
    const hasSubmitted = await this.service.hasSubmission(id, xUserId);
    return { hasSubmitted };
  }

  /** Submits a filled form on behalf of the calling user. */
  @UseGuards(NginxAuthGuard)
  @Post(':id/submit')
  submit(
    @Headers('x-user-id') xUserId: string,
    @Param('id') id: string,
    @Body() dto: SubmitFormDto
  ) {
    return this.service.submit(id, { ...dto, userId: xUserId });
  }

  /** Returns all submissions for the specified form. */
  @Get(':id/submissions')
  getSubmissions(@Param('id') id: string) {
    return this.service.getSubmissions(id);
  }

  /** Returns a single submission by its ID. */
  @Get('submissions/:submissionId')
  getSubmissionById(@Param('submissionId') submissionId: string) {
    return this.service.getSubmissionById(submissionId);
  }

  /** Marks a submission as paid, optionally linking a Stripe session ID. */
  @Post('submissions/:submissionId/mark-paid')
  markPaid(@Param('submissionId') submissionId: string, @Body() body: { sessionId?: string }) {
    return this.service.markPaid(submissionId, body.sessionId);
  }

  /** Cancels a pending submission. */
  @Post('submissions/:submissionId/cancel')
  cancelSubmission(@Param('submissionId') submissionId: string) {
    return this.service.cancelSubmission(submissionId);
  }

  /** Exports all submissions for a form as an XLSX file download. */
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
