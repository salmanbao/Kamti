import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types, Schema as MongooseSchema } from 'mongoose';

export type AmlCheckDocument = AmlCheck &
  Document & {
    createdAt: Date;
    updatedAt: Date;
  };

export enum AmlCheckType {
  Address = 'address',
  Transaction = 'transaction',
}

export enum AmlCheckStatus {
  Pending = 'pending',
  Success = 'success',
  Error = 'error',
}

export enum AmlCheckResposneType {
  Sync = 'sync',
  Async = 'async',
}

@Schema({
  timestamps: true,
  collection: 'aml_checks',
})
export class AmlCheck {
  @Prop({ required: true, type: Types.ObjectId, ref: 'Company' })
  company: Types.ObjectId;

  @Prop({ required: true, enum: AmlCheckType })
  type: AmlCheckType;

  @Prop({ enum: AmlCheckResposneType, required: true })
  response_type: AmlCheckResposneType;

  @Prop({ type: String, default: null })
  uid: string | null;

  @Prop({ type: String, default: null })
  callback_url: string | null;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload: Record<string, any>;

  // === Aml Provider
  @Prop({ enum: AmlCheckStatus, default: AmlCheckStatus.Pending })
  status: AmlCheckStatus;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  provider_response: Record<string, any>;

  // === Callback
  @Prop({ enum: AmlCheckStatus, default: AmlCheckStatus.Pending })
  callback_status: AmlCheckStatus;
}

export const AmlCheckSchema = SchemaFactory.createForClass(AmlCheck);
