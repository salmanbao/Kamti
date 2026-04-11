import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PopulateOptions } from 'mongoose';
import { CompanyDocument } from '@shared/company/schemas/company.schema';
import {
  SwiftCheck,
  SwiftCheckDocument,
} from '@swift/schemas/swift-check.schema';

@Injectable()
export class SwiftCheckRepository {
  constructor(
    @InjectModel(SwiftCheck.name) private model: Model<SwiftCheckDocument>,
  ) {}

  async create(data: Partial<SwiftCheck>): Promise<SwiftCheckDocument> {
    const created = new this.model(data);
    return created.save();
  }

  async findById(id: string): Promise<SwiftCheckDocument | null> {
    return this.model.findById(id).exec();
  }

  async findByQuery(
    query: Partial<SwiftCheck>,
  ): Promise<SwiftCheckDocument | null> {
    return this.model.findOne(query).sort({ createdAt: -1 }).exec();
  }

  async find(query: any): Promise<SwiftCheckDocument[]> {
    return this.model.find(query).sort({ createdAt: -1 }).exec();
  }

  async findByIdWithCompany(
    id: string,
    populateOptions?: PopulateOptions | PopulateOptions[],
  ): Promise<
    (SwiftCheckDocument & { company: CompanyDocument | null }) | null
  > {
    const populateOpts = populateOptions || { path: 'company' };

    const doc = await this.model.findById(id).populate(populateOpts).exec();

    return doc as unknown as
      | (SwiftCheckDocument & { company: CompanyDocument | null })
      | null;
  }

  async update(
    id: string,
    payload: Record<string, any>,
  ): Promise<SwiftCheckDocument | null> {
    return this.model.findByIdAndUpdate(id, payload, { new: true }).exec();
  }

  async deleteById(id: string): Promise<SwiftCheckDocument | null> {
    return this.model.findByIdAndDelete(id).exec();
  }
}
