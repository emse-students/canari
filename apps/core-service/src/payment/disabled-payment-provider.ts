import { BadRequestException, Logger } from '@nestjs/common';
import type {
  CheckoutSessionInfo,
  CheckoutSessionResult,
  ConnectAccountStatusResponse,
  ConnectBalanceSummary,
  OnboardingResult,
  PaymentProvider,
} from './payment-provider.interface';

/** The one message every refused operation carries, so a client can match it and a log can grep it. */
export const PAYMENTS_DISABLED_MESSAGE = 'Payments are disabled on this platform';

/**
 * The provider PaymentService returns when platform_config.payment_provider is 'disabled'.
 *
 * Reports itself as NOT configured, so every route that gates on `isConfigured()` answers exactly
 * as it does when no provider has credentials. Any operation that reaches it anyway fails CLOSED
 * with a 400 - it never falls through to Lydia. Payments already in flight are NOT
 * handled here: the Lydia callback verifies with its own secret, independent
 * of the active provider (see PaymentService.verifyLydiaRequestCallback).
 */
export class DisabledPaymentProvider implements PaymentProvider {
  readonly id = 'disabled' as const;
  private readonly logger = new Logger(DisabledPaymentProvider.name);

  isConfigured(): boolean {
    return false;
  }

  /** Logs the refused operation, then throws - the only behaviour of every method below. */
  private refuse(operation: string): never {
    this.logger.warn(`${operation} refused: ${PAYMENTS_DISABLED_MESSAGE}`);
    throw new BadRequestException(PAYMENTS_DISABLED_MESSAGE);
  }

  async createOnboarding(): Promise<OnboardingResult> {
    return this.refuse('createOnboarding');
  }
  async getAccountStatus(): Promise<{ chargesEnabled: boolean }> {
    return this.refuse('getAccountStatus');
  }
  async getConnectAccountStatus(): Promise<ConnectAccountStatusResponse> {
    return this.refuse('getConnectAccountStatus');
  }
  async getConnectBalance(): Promise<ConnectBalanceSummary> {
    return this.refuse('getConnectBalance');
  }
  async createConnectDashboardLink(): Promise<string> {
    return this.refuse('createConnectDashboardLink');
  }
  async createCheckoutSession(): Promise<CheckoutSessionResult> {
    return this.refuse('createCheckoutSession');
  }
  async retrieveSession(): Promise<CheckoutSessionInfo> {
    return this.refuse('retrieveSession');
  }
}
