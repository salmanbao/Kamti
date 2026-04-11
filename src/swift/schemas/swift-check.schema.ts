import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types, Schema as MongooseSchema } from 'mongoose';
import { SwiftStatus, SwiftUnifiedStatus } from '@swift/types/swift.types';

export type SwiftCheckDocument = SwiftCheck &
  Document & {
    createdAt: Date;
    updatedAt: Date;
  };

@Schema({
  timestamps: true,
  collection: 'swift_checks',
})
export class SwiftCheck {
  @Prop({ required: true, type: Types.ObjectId, ref: 'Company' })
  company: Types.ObjectId;

  @Prop({ type: String, default: null })
  callback_url: string | null;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload: Record<string, any>;

  @Prop({ type: Date, default: null })
  last_checked_at: Date | null;

  @Prop({ type: Number, default: 6 * 60 * 60 * 1000 }) // 6 hours * 60 minutes * 60 seconds * 1000 milliseconds
  recheck_interval_ms: number;

  // === Provider
  @Prop({ enum: SwiftStatus, default: SwiftStatus.PENDING })
  status: SwiftStatus;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  provider_response: Record<string, any>[];

  // === Callback
  @Prop({ enum: SwiftStatus, default: SwiftStatus.PENDING })
  callback_status: SwiftStatus;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  callback_history: Record<string, any>[];
}

export const SwiftCheckSchema = SchemaFactory.createForClass(SwiftCheck);
