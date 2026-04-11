import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { CompanyDocument } from '@shared/company/schemas/company.schema'; // Adjust import to your Company type/interface
import { Request } from 'express';

export const RequestCompany = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): CompanyDocument | undefined => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request['company'];
  },
);
