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
    cy.contains('button', 'Select organization folder').click();

    cy.contains('2 endpoints detected from auth0-routes-fixture.').should('be.visible');
    cy.contains('.endpoint-section', '2 endpoints detected').should('be.visible');
    cy.contains('.endpoint-row', '/api/public/status').within(() => {
      cy.contains('GET').should('be.visible');
      cy.contains('200').should('be.visible');
    });
    cy.contains('.endpoint-row', '/api/auth/:auth0').within(() => {
      cy.contains('GET').should('be.visible');
      cy.contains('200').should('be.visible');
    });
    cy.contains('2 endpoints can be hydrated into a profile.').should('be.visible');
  });

  it('filters detected endpoints and updates the selected mock shape', () => {
    cy.contains('button', 'Select organization folder').click();

    cy.get('input[placeholder="Search endpoints"]').clear().type('auth');
    cy.get('.endpoint-list .endpoint-row').should('have.length', 1);
    cy.contains('.endpoint-row', '/api/auth/:auth0').click().should('have.class', 'selected');

    cy.contains('.sidecar-card', 'Selected mock').within(() => {
      cy.contains('/api/auth/:auth0').should('be.visible');
      cy.contains('callbackUrl').should('be.visible');
      cy.contains('string').should('be.visible');
      cy.contains('https://example.com/api/auth/callback').should('be.visible');
      cy.contains('status').should('be.visible');
      cy.contains('redirect-ready').should('be.visible');
    });
  });

  it('creates and applies a mock profile from detected endpoints', () => {
    cy.contains('button', 'Select organization folder').click();
    cy.contains('button', 'New').click();

    cy.contains('Mock Profile 4 created with 2 endpoint mocks.').should('be.visible');
    cy.contains('.profile-row', 'Mock Profile 4').should('be.visible');

    cy.contains('.browser-preview-card', 'Browser preview').find('select').select('Mock Profile 4');
    cy.get('[data-testid="empty-report"]').should('contain.text', 'Mock Profile 4 will be applied');
  });
});
