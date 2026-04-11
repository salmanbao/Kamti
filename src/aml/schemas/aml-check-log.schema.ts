import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types, Schema as MongooseSchema } from 'mongoose';

export type AmlCheckLogDocument = AmlCheckLog & Document;

export enum AmlCheckLogType {
  Payload = 'payload',
  ProviderResponse = 'provider_response',
  Callback = 'callback',
  Error = 'error',
  Info = 'info',
}

@Schema({
  timestamps: true,
  collection: 'aml_check_logs',
})
export class AmlCheckLog {
  @Prop({ required: true, type: Types.ObjectId, ref: 'AmlCheck' })
  aml_check: Types.ObjectId;

  @Prop({ enum: AmlCheckLogType })
  type: AmlCheckLogType;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  data: any;

  @Prop({ type: String, default: null })
  message: string | null;
}

export const AmlCheckLogSchema = SchemaFactory.createForClass(AmlCheckLog);
