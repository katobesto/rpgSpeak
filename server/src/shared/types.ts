import type { FastifyRequest, FastifyReply } from 'fastify';

export type RouteHandler<
  Body = unknown,
  Params = unknown,
  Querystring = unknown
> = (
  request: FastifyRequest<{ Body: Body; Params: Params; Querystring: Querystring }>,
  reply: FastifyReply
) => Promise<unknown>;

export type IdParam = { id: string };

export interface PaginationQuery {
  page?: number;
  pageSize?: number;
  search?: string;
}
