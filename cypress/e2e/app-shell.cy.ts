describe('App shell', () => {
  beforeEach(() => {
    cy.installMockBridge();
  });

  it('loads the comparison workspace', () => {
    cy.get('[data-testid="comparison-workspace"]').should('be.visible');
    cy.contains('h1', 'Visual comparison').should('be.visible');
    cy.get('[data-testid="empty-report"]').should('be.visible');
    cy.contains('No visual report yet').should('be.visible');
  });

  it('shows repository controls and run action', () => {
    cy.contains('h2', 'Repository').should('be.visible');
    cy.get('[data-testid="run-visual-diff"]').should('be.visible').and('not.be.disabled');
    cy.contains('Run visual diff').should('be.visible');
  });
});
