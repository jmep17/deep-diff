describe('Visual route detection', () => {
  it('maps changed page files to visual comparison routes', () => {
    cy.task('detectVisualRoutesForFiles', {
      changedFiles: [
        'app/page.tsx',
        'app/pricing/page.tsx',
        'app/projects/[projectId]/page.tsx',
        'app/api/products/route.ts',
      ],
    }).then((routes) => {
      const detectedRoutes = routes as Array<{ path: string; urlPath: string; sourceFile: string }>;

      expect(detectedRoutes.map((route) => route.path)).to.deep.equal([
        '/',
        '/pricing',
        '/projects/:projectId',
      ]);
      expect(
        detectedRoutes.find((route) => route.path === '/projects/:projectId')?.urlPath,
      ).to.equal('/projects/project_alpha');
      expect(detectedRoutes.map((route) => route.sourceFile)).not.to.include(
        'app/api/products/route.ts',
      );
    });
  });

  it('expands shared changed files to the fixture visual route set', () => {
    cy.task('detectFixtureChangedRoutes', {
      baseRef: 'main',
      targetRef: 'feature/auth0-preview-callbacks',
    }).then((result) => {
      const detection = result as {
        changedFiles: string[];
        routes: Array<{ path: string; urlPath: string; sourceFile: string }>;
      };

      expect(detection.changedFiles).to.include.members([
        'auth0/application.json',
        'auth0/allowed-url-overrides.json',
        'server.mjs',
        'src/auth/auth0.ts',
      ]);
      expect(detection.routes.map((route) => route.path)).to.include.members([
        '/',
        '/dashboard',
        '/dashboard/settings/auth0',
        '/pricing',
        '/projects/:projectId',
        '/reports/:reportId',
      ]);
      expect(detection.routes).to.have.length(6);
    });
  });
});
