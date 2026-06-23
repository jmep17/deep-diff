import type { EndpointDefinition } from '../../src/lib/types';

// Exercises the renderer half of Phase 2 runtime discovery: an endpoint observed
// at runtime through the sidecar proxy arrives over the `onObservedEndpoints`
// bridge subscription and must be merged into the (mockable) endpoint inventory.
// The main-process producer is covered by scripts/test-sidecar-mocks.mjs; this is
// the consumer (bridge → App.tsx merge → inventory row) that typecheck alone can't.
describe('Runtime-discovered endpoints', () => {
  beforeEach(() => {
    cy.installMockBridge();
  });

  const observed: EndpointDefinition = {
    id: 'GET:/api/cart:',
    method: 'GET',
    path: '/api/cart',
    filePath: '',
    framework: 'observed (runtime)',
    status: 200,
    confidence: 'high',
    fields: [
      { name: 'id', type: 'string', example: 'mock_001' },
      { name: 'status', type: 'string', example: 'ok' },
    ],
    mock: { id: 'mock_001', status: 'ok' },
  };

  const emit = (endpoint: EndpointDefinition) =>
    cy.window().then((win) => {
      (
        win as unknown as { deepDiff: { __emitObservedEndpoint: (e: EndpointDefinition) => void } }
      ).deepDiff.__emitObservedEndpoint(endpoint);
    });

  it('merges a proxy-observed endpoint into the mockable inventory', () => {
    cy.contains('button', 'Select organization folder').click();
    cy.contains('2 endpoints detected from auth0-routes-fixture.').should('be.visible');
    cy.get('.endpoint-list .endpoint-row').should('have.length', 2);

    emit(observed);

    // The observed endpoint shows up as a new inventory row...
    cy.get('.endpoint-list .endpoint-row').should('have.length', 3);
    cy.contains('.endpoint-row', '/api/cart').within(() => {
      cy.contains('GET').should('be.visible');
    });

    // ...and is selectable like any scanned endpoint (i.e. mockable).
    cy.contains('.endpoint-row', '/api/cart').click().should('have.class', 'selected');

    // Idempotent: the same endpoint arriving again does not duplicate the row.
    emit(observed);
    cy.get('.endpoint-list .endpoint-row').should('have.length', 3);
  });
});
