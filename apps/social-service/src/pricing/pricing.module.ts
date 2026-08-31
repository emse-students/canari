import { Module } from '@nestjs/common';
import { UserTagModule } from '../users/user-tag.module';
import { PricingFactsService } from './pricing-facts.service';

/**
 * The criteria a price may rest on, and the facts they are evaluated against.
 *
 * A module of its own because two features price on the same grid: a paid form and a boutique
 * product (a cotisation tier in particular). The matrix, the bucket predicate and the validator
 * are pure functions imported directly; only the facts need injecting, since assembling them
 * reaches core-service for the promo and the formation.
 *
 * It deliberately depends on nothing but `UserTagModule`. `FormsModule` already imports
 * `AssociationsModule`, so anything living in either of those would be a cycle the moment the
 * boutique needed it - which is exactly what happened, and why this module exists.
 */
@Module({
  imports: [UserTagModule],
  providers: [PricingFactsService],
  exports: [PricingFactsService],
})
export class PricingModule {}
