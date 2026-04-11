import { Controller } from '@nestjs/common';
import { CompanyService } from './company.service';

@Controller('companies')
export class CompanyController {
  constructor(private readonly companyService: CompanyService) {}

  // @Post()
  // async create(@Body() createCompanyDto: CreateCompanyDto): Promise<Company> {
  //   return this.companyService.create(createCompanyDto);
  // }

  // @Get(':id')
  // async findOne(@Param('id') id: string): Promise<Company | null> {
  //   console.log("id", id)
  //   return this.companyService.findOne(id);
  // }
}
