import {
  Injectable,
  Logger,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { generateSignature } from '@shared/utils/signature.utils';

@Injectable()
export class SignatureValidationMiddleware implements NestMiddleware {
  private readonly logger = new Logger(SignatureValidationMiddleware.name);

  use(req: Request, res: Response, next: NextFunction) {
    if (req.method !== 'POST') {
      return next();
    }

    const company = (req as any).company;
    if (!company || !company.secret) {
      this.logger.error('Company information is missing');
      throw new UnauthorizedException('Company information is missing');
    }

    const { signature, ...body } = req.body;

    // If body does not have any keys then ignore signature
    if (Object.keys(body).length !== 0) {
      if (!signature) {
        this.logger.error('Signature is missing from the request body');
        throw new UnauthorizedException(
          'Signature is missing from the request body',
        );
      }

      const generatedSignature = generateSignature(body, company.secret);

      if (generatedSignature !== signature) {
        this.logger.error('Signature mismatch!');
        throw new UnauthorizedException('Invalid signature');
      }

      // delete (req as any).company;
    }
    next();
  }
}
