import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

function buildHost(response: { status: jest.Mock; json: jest.Mock }) {
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({}),
    }),
  } as unknown as ArgumentsHost;
}

describe('AllExceptionsFilter', () => {
  let response: { status: jest.Mock; json: jest.Mock };
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    filter = new AllExceptionsFilter();
  });

  it('passes an HttpException through with its original status and body', () => {
    const exception = new BadRequestException('Order must contain items');

    filter.catch(exception, buildHost(response));

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(exception.getResponse());
  });

  it('converts a non-HttpException error into a generic 500 without leaking the message', () => {
    const exception = new Error('columns "wallet_centavosss" does not exist');

    filter.catch(exception, buildHost(response));

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'Internal server error',
    });
  });

  it('handles a thrown non-Error value without crashing the filter itself', () => {
    filter.catch('a plain string throw', buildHost(response));

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'Internal server error',
    });
  });
});
