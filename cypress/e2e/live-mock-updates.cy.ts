/// <reference types="cypress" />

// Exercises the RENDERER half of "Live mock updates without sidecar relaunch":
// toggling an endpoint mock in the floating toolbar of a *running* sidecar must
// push the new override map to the main process via `setSidecarOverrides`
// (the `sidecar:setOverrides` IPC) — without a relaunch. The engine half (the
// proxy actually swapping response bodies live) is proven over HTTP by
// scripts/test-live-mock-update.mjs; this asserts the toggle → IPC wiring that
// the node test can't reach.
describe('Live mock updates without sidecar relaunch', () => {
  beforeEach(() => {
    cy.installMockBridge();
    // Swap the faithful no-op fake for a spy on the live bridge object. App.tsx
    // reads `bridge.setSidecarOverrides` fresh on each effect run, so replacing
    // the method in place is observed by the renderer.
    cy.window().then((win) => {
      const deepDiff = (
        win as unknown as {
          deepDiff: {
            setSidecarOverrides: (o: Record<string, Record<string, unknown>>) => Promise<unknown>;
          };
        }
      ).deepDiff;
      cy.stub(deepDiff, 'setSidecarOverrides')
        .as('setOverrides')
        .resolves({ running: true, url: 'http://127.0.0.1:3199', port: 3199 });
    });

    // Load the fixture endpoints into the inventory + floating toolbar.
    cy.contains('button', 'Select organization folder').click();
    cy.contains('2 endpoints detected from auth0-routes-fixture.').should('be.visible');

    // A running sidecar is the precondition for live updates.
    cy.contains('button', 'Launch sidecar').click();
    cy.contains('.sidecar-state', 'Running').should('be.visible');

    // Reveal the per-endpoint mock toggles in the floating toolbar. force:true
    // because the live preview's <webview> layer sits over the toolbar.
    cy.get('.floating-toolbar [aria-label="Endpoint mocks"]').click({ force: true });
  });

  it('pushes overrides live on toggle-on and clears them on toggle-off, without relaunch', () => {
    // Launch applies the current overrides itself; the renderer records that
    // baseline without re-pushing, so nothing is sent until a real change.
    cy.get('@setOverrides').should('not.have.been.called');

    // Toggle the first endpoint mock ON → effective overrides gain its key, and
    // the change is pushed to the running sidecar (AC1: no relaunch).
    cy.get('.toolbar-endpoint').first().find('[role="switch"]').click({ force: true });
    cy.get('@setOverrides').should('have.been.calledWithMatch', {
      'GET:/api/public/status': { id: 'status_fixture' },
    });

    // Toggle it OFF → effective overrides empty again → an empty map is pushed,
    // which makes the proxy pass through to the real server (AC3).
    cy.get('.toolbar-endpoint').first().find('[role="switch"]').click({ force: true });
    cy.get('@setOverrides').its('lastCall.args.0').should('deep.equal', {});
  });
});
