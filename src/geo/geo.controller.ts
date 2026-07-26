import { Controller, Get, Query } from '@nestjs/common';
import { GeoService } from './geo.service';
import { GeoReverseQueryDto, GeoSearchQueryDto } from './dto/geo.dto';

/**
 * Geocoding proxy for the customer app's address entry.
 *
 * No `@Public()` here on purpose: JwtAuthGuard is registered globally
 * (app.module.ts), so both routes require a valid Supabase bearer token by
 * default. There is no anonymous geocoding — an open proxy is someone else's
 * free geocoding API billed to us.
 *
 * Rate limiting comes from the global UserOrIpThrottlerGuard, keyed on user id.
 */
@Controller('geo')
export class GeoController {
  constructor(private readonly geoService: GeoService) {}

  /**
   * Forward geocode (type-ahead). Always 200 — an upstream failure returns
   * `{ results: [] }` so the client degrades to manual pin-drop. See
   * GeoService.search.
   */
  @Get('search')
  search(@Query() query: GeoSearchQueryDto) {
    return this.geoService.search({
      q: query.q,
      limit: query.limit,
      lat: query.lat,
      lng: query.lng,
    });
  }

  /** Reverse geocode. Always 200; `{ result: null }` when nothing is found. */
  @Get('reverse')
  reverse(@Query() query: GeoReverseQueryDto) {
    return this.geoService.reverse({ lat: query.lat, lng: query.lng });
  }
}
