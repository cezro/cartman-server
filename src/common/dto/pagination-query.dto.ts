// class-transformer's @Type() relies on Reflect.getMetadata, which Nest's
// own bootstrap chain loads transitively — but this DTO is also exercised
// directly in unit specs with no Nest module tree in the import graph, so
// the polyfill must be pulled in explicitly here.
import 'reflect-metadata';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Shared query params for all admin list endpoints. Response envelope is
 * `{ items, total, limit, offset }` (see individual controllers).
 */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}
