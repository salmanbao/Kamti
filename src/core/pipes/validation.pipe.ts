import {
  PipeTransform,
  Injectable,
  ArgumentMetadata,
  BadRequestException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToClass } from 'class-transformer';

/**
 * Custom validation pipe with detailed error messages
 */
@Injectable()
export class CustomValidationPipe implements PipeTransform<any> {
  async transform(value: any, { metatype }: ArgumentMetadata) {
    if (!metatype || !this.toValidate(metatype)) {
      return value;
    }

    // Handle undefined or null values by transforming to empty object
    const valueToValidate = value ?? {};

    const object = plainToClass(metatype, valueToValidate, {
      enableImplicitConversion: true,
    });
    const errors = await validate(object, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    if (errors.length > 0) {
      console.log('errors => ', errors);

      const errorMessages = this.buildErrorMessage(errors);
      throw new BadRequestException({
        message: errorMessages[0] ?? 'Validation failed',
        errors: errorMessages,
      });
    }

    return object; // Return transformed object instead of original value
  }

  private toValidate(metatype: Function): boolean {
    const types: Function[] = [String, Boolean, Number, Array, Object];
    return !types.includes(metatype);
  }

  private buildErrorMessage(errors: any[]): string[] {
    const messages: string[] = [];

    for (const error of errors) {
      if (error.constraints) {
        messages.push(...(Object.values(error.constraints) as string[]));
      }

      if (error.children && error.children.length > 0) {
        messages.push(...this.buildErrorMessage(error.children));
      }
    }

    return messages;
  }
}
