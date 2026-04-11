import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Company, CompanyDocument } from './schemas/company.schema';
import { CreateCompanyDto } from './dto/create-company.dto';
import * as crypto from 'crypto';

@Injectable()
export class CompanyService {
  constructor(
    @InjectModel(Company.name) private companyModel: Model<CompanyDocument>,
  ) {}

  async create(createCompanyDto: CreateCompanyDto): Promise<Company> {
    const apiKey = crypto.randomBytes(20).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    const company = new this.companyModel({
      ...createCompanyDto,
      apiKey,
      secret,
    });
    return company.save();
  }

  async findOne(id: string): Promise<Company | null> {
    return this.companyModel.findById(id).exec();
  }

  async findByApiKey(apiKey: string): Promise<Company | null> {
    return this.companyModel.findOne({ apiKey }).exec();
  }
}
