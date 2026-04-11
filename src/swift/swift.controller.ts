import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { SwiftCheckDto } from './dtos/swift-check.dto';
import { SwiftService } from './services/swift.service';
import { RequestCompany } from '@shared/decorators/request-company.decorator';
import type { CompanyDocument } from '@shared/company/schemas/company.schema';

@Controller('swift')
export class SwiftController {
  constructor(protected readonly swiftService: SwiftService) {}

  @Post('transactions/check')
  @HttpCode(HttpStatus.NO_CONTENT)
  async checkTransaction(
    @Body() payload: SwiftCheckDto,
    @RequestCompany() company: CompanyDocument,
  ) {
    const companyId = company?._id?.toString() || '';

    await this.swiftService.checkTransaction(payload, companyId);
  }
}
