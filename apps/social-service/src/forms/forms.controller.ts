import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Res,
  NotFoundException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { CreateFormDto, SubmitFormDto } from './dto/form.dto';
import { FormsService } from './forms.service';
import { AssociationsService } from '../associations/associations.service';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { UserTagService } from '../users/user-tag.service';

/** Manages form resources including submissions, payment status, XLSX exports, and purchase history. */
@Controller('forms')
export class FormsController {
  constructor(
    private readonly service: FormsService,
    private readonly associationsService: AssociationsService,
    private readonly purchaseRecordService: PurchaseRecordService,
    private readonly userTagService: UserTagService
  ) {}

  /** Creates a new form owned by the calling user. */
  @UseGuards(NginxAuthGuard)
  @Post()
  create(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string,
    @Body() dto: CreateFormDto
  ) {
    return this.service.create({ ...dto, ownerId: xUserId }, xGlobalAdmin === 'true');
  }

  /** Returns all forms owned by the calling user. */
  @UseGuards(NginxAuthGuard)
  @Get()
  list(@Headers('x-user-id') xUserId: string) {
    return this.service.list(xUserId);
  }

  /** Association agenda entry linked to this form, if configured. */
  @Get(':id/calendar-link')
  async getFormCalendarLink(@Param('id') id: string) {
    const linkedEvent = await this.associationsService.findCalendarEventByLinkedForm(id);
    return { linkedEvent };
  }

  /** Returns a single form by its ID. */
  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  /** Updates a form's metadata and items. Requires owner, co-owner, or MANAGE_FORMS flag. */
  @UseGuards(NginxAuthGuard)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') ga?: string,
    @Body() dto?: CreateFormDto
  ) {
    return this.service.update(id, dto, xUserId, ga === 'true');
  }

  /** Uploads a banner image for a form. Requires owner, co-owner, or MANAGE_FORMS flag. */
  @UseGuards(NginxAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  @Post(':id/image')
  uploadImage(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') ga?: string,
    @Headers('authorization') authorization?: string
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.service.setImageFromUpload(id, file, xUserId, ga === 'true', authorization);
  }

  /** Removes the banner image from a form. Requires owner, co-owner, or MANAGE_FORMS flag. */
  @UseGuards(NginxAuthGuard)
  @Delete(':id/image')
  deleteImage(
    @Param('id') id: string,
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.clearImage(id, xUserId, ga === 'true');
  }

  /** Adds a co-owner to a form. Only the owner or global admin may call this. */
  @UseGuards(NginxAuthGuard)
  @Post(':id/co-owners')
  addCoOwner(
    @Param('id') id: string,
    @Body() body: { userId: string },
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.addCoOwner(id, body.userId, xUserId, ga === 'true');
  }

  /** Removes a co-owner from a form. Only the owner or global admin may call this. */
  @UseGuards(NginxAuthGuard)
  @Delete(':id/co-owners/:coUserId')
  removeCoOwner(
    @Param('id') id: string,
    @Param('coUserId') coUserId: string,
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.removeCoOwner(id, coUserId, xUserId, ga === 'true');
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

  /** Returns all submissions for the specified form. Requires form owner or MANAGE_FORMS flag. */
  @UseGuards(NginxAuthGuard)
  @Get(':id/submissions')
  async getSubmissions(
    @Param('id') id: string,
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    await this.service.assertFormManager(id, xUserId, ga === 'true');
    return this.service.getSubmissions(id);
  }

  /** Returns a single submission by its ID. Requires the submitter or a form manager. */
  @UseGuards(NginxAuthGuard)
  @Get('submissions/:submissionId')
  async getSubmissionById(
    @Param('submissionId') submissionId: string,
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    await this.service.assertSubmissionAccess(submissionId, xUserId, ga === 'true');
    return this.service.getSubmissionById(submissionId);
  }

  /** Marks a submission as paid after Stripe redirect. Requires the submitter or a form manager. */
  @UseGuards(NginxAuthGuard)
  @Post('submissions/:submissionId/mark-paid')
  markPaid(
    @Param('submissionId') submissionId: string,
    @Body() body: { sessionId?: string },
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.markPaid(submissionId, body.sessionId, xUserId, ga === 'true');
  }

  /** Cancels a pending submission. Requires the submitter or a form manager. */
  @UseGuards(NginxAuthGuard)
  @Post('submissions/:submissionId/cancel')
  cancelSubmission(
    @Param('submissionId') submissionId: string,
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.cancelSubmission(submissionId, xUserId, ga === 'true');
  }

  // ── Cash payment admin endpoints ─────────────────────────────────────────

  /** Lists submissions awaiting cash validation. Requires form owner or MANAGE_FORMS flag. */
  @UseGuards(NginxAuthGuard)
  @Get(':id/submissions/pending-cash')
  listPendingCash(
    @Param('id') id: string,
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.listPendingCash(id, xUserId, ga === 'true');
  }

  /** Validates a cash payment. Requires form owner or MANAGE_FORMS flag. */
  @UseGuards(NginxAuthGuard)
  @Post(':id/submissions/:submissionId/validate-cash')
  validateCash(
    @Param('id') id: string,
    @Param('submissionId') submissionId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.validateCashPayment(id, submissionId, userId, ga === 'true');
  }

  /** Cancels a pending cash submission. Requires form owner or MANAGE_FORMS flag. */
  @UseGuards(NginxAuthGuard)
  @Post(':id/submissions/:submissionId/cancel-cash')
  cancelCash(
    @Param('id') id: string,
    @Param('submissionId') submissionId: string,
    @Headers('x-user-id') callerId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.cancelCashPayment(id, submissionId, callerId, ga === 'true');
  }

  /** Subscribes the calling user to open-time reminders for a form. */
  @UseGuards(NginxAuthGuard)
  @Post(':id/remind')
  subscribeReminder(@Param('id') id: string, @Headers('x-user-id') xUserId: string) {
    return this.service.subscribeReminder(id, xUserId);
  }

  /** Unsubscribes the calling user from reminders for a form. */
  @UseGuards(NginxAuthGuard)
  @Delete(':id/remind')
  unsubscribeReminder(@Param('id') id: string, @Headers('x-user-id') xUserId: string) {
    return this.service.unsubscribeReminder(id, xUserId);
  }

  /** Returns whether the calling user has an active reminder for a form. */
  @UseGuards(NginxAuthGuard)
  @Get(':id/remind')
  checkReminder(@Param('id') id: string, @Headers('x-user-id') xUserId: string) {
    return this.service.checkReminder(id, xUserId);
  }

  /**
   * Returns the calling user's full purchase history: paid form submissions,
   * boutique product purchases, and active cotisation tags.
   */
  @UseGuards(NginxAuthGuard)
  @Get('me/purchases')
  async myPurchases(@Headers('x-user-id') userId: string) {
    const [purchases, activeTags] = await Promise.all([
      this.purchaseRecordService.listByUser(userId),
      this.userTagService.listByUser(userId),
    ]);
    return {
      purchases,
      activeTags,
      cercleTopups: purchases.filter((p) => p.source === 'product'),
    };
  }

  /** Exports all submissions for a form as an XLSX file download. Requires form owner or MANAGE_FORMS flag. */
  @UseGuards(NginxAuthGuard)
  @Get(':id/export')
  async export(
    @Param('id') id: string,
    @Res() res: Response,
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    await this.service.assertFormManager(id, xUserId, ga === 'true');
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
