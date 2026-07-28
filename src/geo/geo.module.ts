import { Module } from '@nestjs/common';
import { GeoController } from './geo.controller';
import { GeoService, GEOCODER } from './geo.service';
import { MapboxGeocoder, type Geocoder } from './geocoder';

/**
 * Geocoding proxy module.
 *
 * The provider is chosen here from the environment, which is the whole point of
 * the [Geocoder] interface: swapping backends is a deploy, not an app release.
 * Adding one means writing a Geocoder impl and a case below — nothing in
 * GeoService, the controller, or the mobile app changes.
 *
 * With no token configured the module still loads and the endpoints still
 * answer 200 with empty results (GeoService's fail-soft contract), so the app
 * works — degraded to manual pin-drop — before anyone has issued a token.
 * Booting must never *require* a geocoding key.
 */
@Module({
  controllers: [GeoController],
  providers: [
    {
      provide: GEOCODER,
      useFactory: (): Geocoder | null => {
        const token = process.env.MAPBOX_TOKEN;
        if (!token) return null;
        return new MapboxGeocoder(token);
      },
    },
    GeoService,
  ],
  exports: [GeoService],
})
export class GeoModule {}
