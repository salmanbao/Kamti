import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PopulateOptions } from 'mongoose';
import { AmlCheck, AmlCheckDocument } from '../schemas/aml-check.schema';
import { CompanyDocument } from '@shared/company/schemas/company.schema';

@Injectable()
export class AmlCheckRepository {
  constructor(
    @InjectModel(AmlCheck.name) private amlCheckModel: Model<AmlCheckDocument>,
  ) {}

  async create(data: Partial<AmlCheck>): Promise<AmlCheckDocument> {
    const created = new this.amlCheckModel(data);
    return created.save();
  }

  async findByUid(uid: string): Promise<AmlCheckDocument | null> {
    return this.amlCheckModel.findOne({ uid }).exec();
  }

  async findById(id: string): Promise<AmlCheckDocument | null> {
    return this.amlCheckModel.findById(id).exec();
  }

  async findByQuery(
    query: Partial<AmlCheck>,
  ): Promise<AmlCheckDocument | null> {
    return this.amlCheckModel.findOne(query).sort({ createdAt: -1 }).exec();
  }

  async findByIdWithCompany(
    id: string,
    populateOptions?: PopulateOptions | PopulateOptions[],
  ): Promise<(AmlCheckDocument & { company: CompanyDocument | null }) | null> {
    const populateOpts = populateOptions || { path: 'company' };

    const doc = await this.amlCheckModel
      .findById(id)
      .populate(populateOpts)
      .exec();

    return doc as unknown as
      | (AmlCheckDocument & { company: CompanyDocument | null })
      | null;
  }

  async update(
    id: string,
    payload: Record<string, any>,
  ): Promise<AmlCheckDocument | null> {
    return this.amlCheckModel
      .findByIdAndUpdate(id, payload, { new: true })
      .exec();
  }

  async updateUid(id: string, uid: string): Promise<AmlCheckDocument | null> {
    return this.amlCheckModel
      .findByIdAndUpdate(id, { uid }, { new: true })
      .exec();
  }

  async deleteById(id: string): Promise<AmlCheckDocument | null> {
    return this.amlCheckModel.findByIdAndDelete(id).exec();
  }

  async findWithFilters(filters: {
    fromDate?: Date;
    toDate?: Date;
    status?: string;
    currency?: string;
    sortBy?: string;
    search?: string;
    page: number;
    pageSize: number;
    companyId: string;
    isFake?: string;
  }): Promise<{ data: AmlCheckDocument[]; total: number }> {
    const {
      fromDate,
      toDate,
      status,
      currency,
      sortBy,
      page,
      pageSize,
      companyId,
      search,
    } = filters;

    const query: any = {};

    // Date range filter on createdAt
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) {
        query.createdAt.$gte = fromDate;
      }
      if (toDate) {
        query.createdAt.$lte = toDate;
      }
    }

    // Status filter from provider_response.risk_status (if provided and not null)
    if (status) {
      query['provider_response.risk_status'] = status;
    }

    if (search) {
      const trimmed = search.trim();
      if (trimmed) {
        const orQuery: any[] = [];
        orQuery.push({ 'payload.address': { $regex: trimmed, $options: 'i' } });
        orQuery.push({ 'payload.tx_hash': { $regex: trimmed, $options: 'i' } });
        query.$or = orQuery;
      }
    }

    if (filters.isFake === 'true') {
      query['payload.isFake'] = 'true';
    } else {
      query['payload.isFake'] = 'false';
    }

    // query.provider_response = { $ne: null };
    query.company = companyId;

    // Currency filter from payload.ticker (if provided and not null)
    if (currency) {
      query['payload.ticker'] = currency;
    }

    // Parse sortBy (e.g., 'createdAt:desc' -> { createdAt: -1 })
    const sort: any = {};
    if (sortBy) {
      const [field, direction] = sortBy.split(':');
      sort[field] = direction === 'asc' ? 1 : -1;
    }

    // Pagination
    const skip = (page - 1) * pageSize;

    // Execute query for data
    const data = await this.amlCheckModel
      .find(query)
      .sort(sort)
      .skip(skip)
      .limit(pageSize)
      .exec();

    // Get total count for pagination
    const total = await this.amlCheckModel.countDocuments(query).exec();

    return { data, total };
  }
}
