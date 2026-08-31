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
import { AssociationCategory } from './entities/association-category.entity';
import { PosterProject } from './entities/poster-project.entity';
import { AssociationProduct } from './entities/association-product.entity';
import { WebhookDelivery } from './entities/webhook-delivery.entity';
import { AssociationRoleHistory } from './entities/association-role-history.entity';
import { PartnershipCard } from './entities/partnership-card.entity';
import { PartnershipCode } from './entities/partnership-code.entity';
import { Post } from '../posts/entities/post.entity';
import { Form } from '../forms/entities/form.entity';
import { PostNotification } from '../posts/entities/post-notification.entity';
import { AssociationsService } from './associations.service';
import { UserProfileService } from './user-profile.service';
import { ProductsService } from './products.service';
import { PartnershipsService } from './partnerships.service';
import { CercleDeliveryScheduler } from './cercle-delivery.scheduler';
import { AssociationCategoriesService } from './association-categories.service';
import { PosterService } from './poster.service';
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
      AssociationCategory,
      PosterProject,
      AssociationProduct,
      WebhookDelivery,
      AssociationRoleHistory,
      PartnershipCard,
      PartnershipCode,
      Post,
      Form,
      PostNotification,
    ]),
    FollowsModule,
    UserTagModule,
    PurchaseRecordModule,
    PricingModule,
  ],
  providers: [
    AssociationsService,
    UserProfileService,
    ProductsService,
    PartnershipsService,
    CercleDeliveryScheduler,
    AssociationCategoriesService,
    PosterService,
    GlobalAdminOrAssociationRoleGuard,
    GlobalAdminOrBdeSuperAdminGuard,
    ReviewerAccessGuard,
    PushService,
  ],
  // Category/poster controllers are listed FIRST so their literal `associations/categories`
  // and `associations/poster` routes register before the `associations/:id` matcher.
  controllers: [AssociationCategoriesController, PosterController, AssociationsController],
  exports: [
    AssociationsService,
    ProductsService,
    PartnershipsService,
    UserProfileService,
    PosterService,
  ],
})
export class AssociationsModule {}
