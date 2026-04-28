import { z } from 'zod';

export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PaginationResult<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};

export function paginate<T>(
  items: T[],
  total: number,
  limit: number,
  offset: number,
): PaginationResult<T> {
  return { items, total, limit, offset };
}
