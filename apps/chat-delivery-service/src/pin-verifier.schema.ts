import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PinVerifierDocument = HydratedDocument<PinVerifier>;

/**
 * Stores a PBKDF2-derived verifier for each user so that all devices are
 * forced to use the same PIN.
 *
 * Security properties:
 *  - The raw PIN is never sent or stored; only the PBKDF2 output is stored.
 *  - Comparison uses timingSafeEqual to prevent timing-based inference.
 *  - The verifier is deterministic per (userId, PIN) pair so all devices
 *    independently produce the same value.
 */
@Schema()
export class PinVerifier {
  @Prop({ required: true, unique: true })
  userId: string;

  /** Hex-encoded PBKDF2-SHA-256 output (32 bytes = 64 hex chars). */
  @Prop({ required: true })
  verifier: string;

  @Prop({ default: Date.now })
  registeredAt: Date;
}

export const PinVerifierSchema = SchemaFactory.createForClass(PinVerifier);
