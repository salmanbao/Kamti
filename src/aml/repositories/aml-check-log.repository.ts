import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AmlCheckLog,
  AmlCheckLogDocument,
  AmlCheckLogType,
} from '../schemas/aml-check-log.schema';

@Injectable()
export class AmlCheckLogRepository {
  constructor(
    @InjectModel(AmlCheckLog.name)
    private amlCheckLogModel: Model<AmlCheckLogDocument>,
  ) {}

  async create(data: Partial<AmlCheckLog>): Promise<AmlCheckLogDocument> {
    const created = new this.amlCheckLogModel(data);
    return created.save();
  }

  async createLog(
    aml_check_id: string,
    data: any,
    type: string = AmlCheckLogType.ProviderResponse,
  ): Promise<AmlCheckLogDocument> {
    const created = new this.amlCheckLogModel({
      aml_check: aml_check_id,
      type,
      data,
    });
    return created.save();
  }

  async findById(id: string): Promise<AmlCheckLogDocument | null> {
    return this.amlCheckLogModel.findById(id).exec();
  }

  async update(
    id: string,
    payload: Record<string, any>,
  ): Promise<AmlCheckLogDocument | null> {
    return this.amlCheckLogModel
      .findByIdAndUpdate(id, payload, { new: true })
      .exec();
  }

  async deleteById(id: string): Promise<AmlCheckLogDocument | null> {
    return this.amlCheckLogModel.findByIdAndDelete(id).exec();
  }
}
