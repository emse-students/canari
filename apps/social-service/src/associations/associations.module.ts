import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { Association } from './entities/association.entity';
import { AssociationMember } from './entities/association-member.entity';
import { AssociationCalendarEvent } from './entities/association-calendar-event.entity';
import { AssociationCalendarEventCoOwner } from './entities/association-calendar-event-co-owner.entity';
import { AssociationDocument } from './entities/association-document.entity';
import { DocumentReviewerGrant } from './entities/document-reviewer-grant.entity';
import { AgendaSubscription } from './entities/agenda-subscription.entity';
import { PosterZone } from './entities/poster-zone.entity';
import { PosterEntry } from './entities/poster-entry.entity';
import { PosterProject } from './entities/poster-project.entity';
import { AssociationProduct } from './entities/association-product.entity';
import { WebhookDelivery } from './entities/webhook-delivery.entity';
import { ProductCheckout } from './entities/product-checkout.entity';
import { AssociationRoleHistory } from './entities/association-role-history.entity';
import { PartnershipCard } from './entities/partnership-card.entity';
import { PartnershipCode } from './entities/partnership-code.entity';
import { Space } from '../spaces/space.entity';
import { AssociationAudience } from '../spaces/association-audience.entity';
import { SpacesController, AssociationAudiencesController } from '../spaces/spaces.controller';
import { AdminAssociationsController } from './admin-associations.controller';
import { SpacesService } from '../spaces/spaces.service';
import { ReadGrantsController } from '../read-grants/read-grants.controller';
import { ReadGrantsService } from '../read-grants/read-grants.service';
import { Post } from '../posts/entities/post.entity';
import { Form } from '../forms/entities/form.entity';
import { Submission } from '../forms/entities/submission.entity';
import { FormWaitlistNoticeService } from '../forms/waitlist-notice.service';
import { PostNotification } from '../posts/entities/post-notification.entity';
import { PostNotificationsService } from '../posts/post-notifications.service';
import { AssociationsService } from './associations.service';
import { AssociationDocumentRetentionService } from './association-document-retention.service';
import { UserProfileService } from './user-profile.service';
import { ProductsService } from './products.service';
import { PartnershipsService } from './partnerships.service';
import { CercleDeliveryScheduler } from './cercle-delivery.scheduler';
import { PaidNotGrantedScheduler } from './paid-not-granted.scheduler';
import { PosterService } from './poster.service';
import { LydiaCashierNotifier, LydiaPaymentsNotifier } from './lydia-payments-notifier.service';
import { LydiaCashiersService } from './lydia-cashiers.service';
import { AssociationsController } from './associations.controller';
import { AssociationCategoriesController } from './association-categories.controller';
import { PosterController } from './poster.controller';
import { GlobalAdminOrAssociationRoleGuard } from './guards/global-admin-or-association-role.guard';
import { GlobalAdminOrBdeSuperAdminGuard } from './guards/global-admin-or-bde-super-admin.guard';
import { ReviewerAccessGuard } from './guards/reviewer-access.guard';
import { FollowsModule } from '../follows/follows.module';
import { PushService } from '../push/push.service';
import { UserTagModule } from '../users/user-tag.module';
import { PurchaseRecordModule } from '../users/purchase-record.module';
import { PricingModule } from '../pricing/pricing.module';
import { LydiaRefund } from './refunds/lydia-refund.entity';
import { RefundsService } from './refunds/refunds.service';
import { LydiaRefundNotifier } from './refunds/lydia-refund-notifier.service';
import { RefundsController } from './refunds/refunds.controller';

@Module({
  imports: [
    ConfigModule,
    HttpModule.register({ timeout: 120_000, maxRedirects: 0 }),
    TypeOrmModule.forFeature([
      Association,
      AssociationMember,
      AssociationCalendarEvent,
      AssociationCalendarEventCoOwner,
      AssociationDocument,
      DocumentReviewerGrant,
      PosterZone,
      PosterEntry,
      PosterProject,
      AssociationProduct,
      WebhookDelivery,
      ProductCheckout,
      AssociationRoleHistory,
      PartnershipCard,
      PartnershipCode,
      Post,
      Form,
      // The answers a refund's promotion tells (`FormWaitlistNoticeService`, provided below).
      Submission,
      PostNotification,
      Space,
      AssociationAudience,
      LydiaRefund,
      AgendaSubscription,
    ]),
    FollowsModule,
    UserTagModule,
    PurchaseRecordModule,
    PricingModule,
  ],
  providers: [
    SpacesService,
    ReadGrantsService,
    AssociationsService,
    AssociationDocumentRetentionService,
    UserProfileService,
    ProductsService,
    PartnershipsService,
    CercleDeliveryScheduler,
    PaidNotGrantedScheduler,
    PosterService,
    GlobalAdminOrAssociationRoleGuard,
    GlobalAdminOrBdeSuperAdminGuard,
    ReviewerAccessGuard,
    PushService,
    // PROVIDED HERE RATHER THAN IMPORTED, because `PostsModule` already imports this one and a
    // second edge back would be a cycle. Its three dependencies - the notification repository, the
    // post repository and `PushService` - are all in this module already, and the service is
    // stateless, so a second instance costs nothing and buys the mapping that keeps a push
    // translatable.
    PostNotificationsService,
    LydiaPaymentsNotifier,
    LydiaCashierNotifier,
    LydiaCashiersService,
    RefundsService,
    LydiaRefundNotifier,
    // THE WAITING LIST'S ONE NOTICE, provided HERE so both its promoters reach the same instance: a
    // refund (`RefundsService`, this module) and every form event (`FormsService`, whose module
    // imports this one - the reverse edge would be a cycle).
    FormWaitlistNoticeService,
  ],
  // The category shim and the poster controller are listed FIRST so their literal `associations/categories`
  // and `associations/poster` routes register before the `associations/:id` matcher.
  controllers: [
    AssociationCategoriesController,
    SpacesController,
    ReadGrantsController,
    AssociationAudiencesController,
    AdminAssociationsController,
    PosterController,
    AssociationsController,
    RefundsController,
  ],
  exports: [
    AssociationsService,
    ProductsService,
    PartnershipsService,
    UserProfileService,
    PosterService,
    LydiaPaymentsNotifier,
    LydiaCashierNotifier,
    LydiaCashiersService,
    // The admin queues' notices write through it (`AdminQueuesModule`), with the same mapping.
    // Exported from HERE and not reached through `PostsModule`, because `PostsModule` imports
    // `ModerationModule`, which imports `AdminQueuesModule` (a report is announced when filed): an
    // edge back to `PostsModule` would be a cycle. `InternalModule` imports both modules, so it may
    // be handed either instance - harmless, the service holds no state (see the provider above).
    PostNotificationsService,
    FormWaitlistNoticeService,
  ],
})
export class AssociationsModule {}
