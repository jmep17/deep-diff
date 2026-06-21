/// <reference types="cypress" />

import { buildMockBridge, type MockBridgeOptions } from './mock-bridge';

declare global {
  namespace Cypress {
    interface Chainable {
      installMockBridge(options?: MockBridgeOptions): Chainable<void>;
      runVisualDiff(): Chainable<void>;
    }
  }
}

Cypress.Commands.add('installMockBridge', (options = {}) => {
  cy.visit('/', {
    onBeforeLoad(win) {
      (win as Window & { deepDiff?: ReturnType<typeof buildMockBridge> }).deepDiff =
        buildMockBridge(options);
    },
  });
});

Cypress.Commands.add('runVisualDiff', () => {
  cy.get('[data-testid="run-visual-diff"]').should('not.be.disabled').click();
});

export {};
