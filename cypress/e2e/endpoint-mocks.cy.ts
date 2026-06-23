describe('Endpoint detection and mocks', () => {
  beforeEach(() => {
    cy.installMockBridge();
  });

  it('detects fixture endpoints through the real scanner and builds mock payloads', () => {
    cy.task('scanFixtureEndpoints').then((endpoints) => {
      const detectedEndpoints = endpoints as Array<{
        method: string;
        path: string;
        status: number;
        fields: Array<{ name: string; type: string; example: string }>;
        mock: Record<string, unknown>;
      }>;

      expect(detectedEndpoints.length).to.be.at.least(23);

      const statusEndpoint = detectedEndpoints.find(
        (endpoint) => endpoint.method === 'GET' && endpoint.path === '/api/public/status',
      );
      expect(statusEndpoint).to.exist;
      expect(statusEndpoint?.status).to.equal(200);
      expect(statusEndpoint?.fields.map((field) => field.name)).to.include.members([
        'id',
        'status',
      ]);
      expect(statusEndpoint?.mock).to.include({ id: 'mock_001', status: 'ok' });

      const orderEndpoint = detectedEndpoints.find(
        (endpoint) => endpoint.method === 'POST' && endpoint.path === '/api/orders',
      );
      expect(orderEndpoint).to.exist;
      expect(orderEndpoint?.status).to.equal(201);
      expect(orderEndpoint?.fields.map((field) => field.name)).to.include.members([
        'id',
        'status',
        'total',
      ]);
      expect(orderEndpoint?.mock).to.include({ id: 'mock_001', status: 'ok', total: 18.5 });

      const authEndpoint = detectedEndpoints.find(
        (endpoint) => endpoint.path === '/api/auth/:auth0',
      );
      expect(authEndpoint).to.exist;
      expect(authEndpoint?.mock).to.have.property('callbackUrl', 'https://example.com/pizza.png');
    });
  });

  it('hydrates the endpoint inventory after selecting a workspace', () => {
    cy.contains('button', 'Open repository folder').click();

    cy.contains('2 endpoints detected from auth0-routes-fixture.').should('be.visible');
    // Every detected endpoint is mocked by default (single live set).
    cy.contains('.endpoint-section', '2 of 2 mocked').should('be.visible');
    cy.contains('.endpoint-row', '/api/public/status').within(() => {
      cy.contains('GET').should('be.visible');
    });
    cy.contains('.endpoint-row', '/api/auth/:auth0').within(() => {
      cy.contains('GET').should('be.visible');
    });
    cy.contains('.endpoint-section button', 'Enable all').should('be.visible');
    cy.contains('.endpoint-section button', 'Disable all').should('be.visible');
  });

  it('filters detected endpoints and updates the selected mock shape', () => {
    cy.contains('button', 'Open repository folder').click();

    cy.get('input[placeholder="Search endpoints"]').clear().type('auth');
    cy.get('.endpoint-list .endpoint-row').should('have.length', 1);
    cy.contains('.endpoint-row', '/api/auth/:auth0').find('.mock-row-main').click();
    cy.contains('.endpoint-row', '/api/auth/:auth0').should('have.class', 'selected');

    cy.contains('.sidecar-card', 'Selected mock').within(() => {
      cy.contains('/api/auth/:auth0').should('be.visible');
      cy.contains('callbackUrl').should('be.visible');
      cy.contains('string').should('be.visible');
      cy.contains('https://example.com/api/auth/callback').should('be.visible');
      cy.contains('status').should('be.visible');
      cy.contains('redirect-ready').should('be.visible');
    });
  });

  it('mocks every detected endpoint by default and toggles them individually', () => {
    cy.contains('button', 'Open repository folder').click();

    // Single live set: every detected endpoint is mocked and applied to the next run.
    cy.get('[data-testid="empty-report"]').should(
      'contain.text',
      '2 of 2 endpoint mocks active for the next comparison run',
    );

    // Turning one endpoint's mock off drops the live count everywhere.
    cy.get('[aria-label="Mock GET /api/auth/:auth0"]').click();
    cy.contains('.endpoint-section', '1 of 2 mocked').should('be.visible');
    cy.get('[data-testid="empty-report"]').should(
      'contain.text',
      '1 of 2 endpoint mocks active for the next comparison run',
    );

    // The master switch pauses the whole set (full pass-through on the next run).
    cy.get('[aria-label="Enable all endpoint mocks"]').click();
    cy.get('[data-testid="empty-report"]').should(
      'contain.text',
      'Mocks paused for the next comparison run',
    );
  });
});
