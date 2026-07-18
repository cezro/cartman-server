import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  PlaceMerchantOrderDto,
  PlaceErrandOrderDto,
  PlaceMultiStopOrderDto,
  PlacePickupDropoffOrderDto,
  UpdateOrderStatusDto,
} from './place-order.dto';

describe('PlaceMerchantOrderDto', () => {
  it('accepts exactly the fields the mobile client sends (merchant_id, items[{menu_item_id, qty}])', async () => {
    const dto = plainToInstance(PlaceMerchantOrderDto, {
      merchant_id: '11111111-1111-4111-8111-111111111111',
      items: [{ menu_item_id: '22222222-2222-4222-8222-222222222222', qty: 2 }],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts an optional modifiers array on an item', async () => {
    const dto = plainToInstance(PlaceMerchantOrderDto, {
      merchant_id: '11111111-1111-4111-8111-111111111111',
      items: [
        {
          menu_item_id: '22222222-2222-4222-8222-222222222222',
          qty: 1,
          modifiers: ['extra rice'],
        },
      ],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects a missing merchant_id', async () => {
    const dto = plainToInstance(PlaceMerchantOrderDto, {
      items: [{ menu_item_id: '22222222-2222-4222-8222-222222222222', qty: 1 }],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an empty items array element missing qty', async () => {
    const dto = plainToInstance(PlaceMerchantOrderDto, {
      merchant_id: '11111111-1111-4111-8111-111111111111',
      items: [{ menu_item_id: '22222222-2222-4222-8222-222222222222' }],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('PlaceErrandOrderDto', () => {
  it('accepts the exact shape mobile sends: {errand_payload: null, notes}', async () => {
    const dto = plainToInstance(PlaceErrandOrderDto, {
      errand_payload: null,
      notes: 'Buy 2kg rice',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts an empty body (both fields optional)', async () => {
    const dto = plainToInstance(PlaceErrandOrderDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});

describe('PlacePickupDropoffOrderDto', () => {
  const validBody = {
    pickup_lat: 10.5,
    pickup_lng: 122.1,
    pickup_text: 'SM Antique',
    dropoff_lat: 10.6,
    dropoff_lng: 122.2,
    dropoff_text: 'Home',
    notes: 'Ring the bell',
  };

  it('accepts exactly what mobile sends for courier/ride (_pickupDropoffBody)', async () => {
    const dto = plainToInstance(PlacePickupDropoffOrderDto, validBody);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts optional recipient_name/recipient_phone (courier-only fields)', async () => {
    const dto = plainToInstance(PlacePickupDropoffOrderDto, {
      ...validBody,
      recipient_name: 'Juan',
      recipient_phone: '+639171234567',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects missing dropoff coordinates', async () => {
    const { dropoff_lat, dropoff_lng, ...rest } = validBody;
    void dropoff_lat;
    void dropoff_lng;
    const dto = plainToInstance(PlacePickupDropoffOrderDto, rest);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('PlaceMultiStopOrderDto', () => {
  const validBody = {
    stops: [
      {
        seq: 0,
        kind: 'pickup',
        label: 'SM Antique',
        lat: 10.5,
        lng: 122.1,
        payload: { item: 'documents' },
      },
      {
        seq: 1,
        kind: 'deliver',
        label: 'Home',
        lat: 10.6,
        lng: 122.2,
        payload: {},
      },
    ],
    notes: 'Fragile',
    payment: 'cod',
  };

  it('accepts the §1 contract body (stops[], notes, payment)', async () => {
    const dto = plainToInstance(PlaceMultiStopOrderDto, validBody);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts a body without notes/payment/labels/payloads (all optional)', async () => {
    const dto = plainToInstance(PlaceMultiStopOrderDto, {
      stops: [
        { seq: 0, kind: 'pickup', lat: 10.5, lng: 122.1 },
        { seq: 1, kind: 'deliver', lat: 10.6, lng: 122.2 },
      ],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("accepts a 'buy' stop — the Multi-Stop Builder's Pabili task tile", async () => {
    const dto = plainToInstance(PlaceMultiStopOrderDto, {
      stops: [
        { seq: 0, kind: 'pickup', lat: 10.5, lng: 122.1 },
        {
          seq: 1,
          kind: 'buy',
          label: 'Sari-sari store',
          lat: 10.55,
          lng: 122.15,
        },
        { seq: 2, kind: 'deliver', lat: 10.6, lng: 122.2 },
      ],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects fewer than 2 stops', async () => {
    const dto = plainToInstance(PlaceMultiStopOrderDto, {
      stops: [validBody.stops[0]],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an unknown stop kind', async () => {
    const dto = plainToInstance(PlaceMultiStopOrderDto, {
      stops: [{ ...validBody.stops[0], kind: 'teleport' }, validBody.stops[1]],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a stop with missing coordinates', async () => {
    const dto = plainToInstance(PlaceMultiStopOrderDto, {
      stops: [{ seq: 0, kind: 'pickup', label: 'A' }, validBody.stops[1]],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a negative seq', async () => {
    const dto = plainToInstance(PlaceMultiStopOrderDto, {
      stops: [{ ...validBody.stops[0], seq: -1 }, validBody.stops[1]],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('UpdateOrderStatusDto', () => {
  it('accepts each legal rider-driven status', async () => {
    for (const status of [
      'accepted',
      'arrived_at_merchant',
      'picked_up',
      'in_transit',
      'delivered',
    ]) {
      const dto = plainToInstance(UpdateOrderStatusDto, { status });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects an unknown status value', async () => {
    const dto = plainToInstance(UpdateOrderStatusDto, { status: 'bogus' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
