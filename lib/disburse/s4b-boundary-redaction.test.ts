import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

type ParsedSource = {
  path: string;
  sourceFile: ts.SourceFile;
};

function parseSource(source: string, path = 'fixture.ts'): ParsedSource {
  const scriptKind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind) as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] };
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostics = sourceFile.parseDiagnostics.map((diagnostic) => {
      const location = diagnostic.start === undefined
        ? ''
        : (() => {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
            return `:${line + 1}:${character + 1}`;
          })();
      return `${path}${location} TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
    });
    assert.fail(`Source contains parse diagnostics:\n${diagnostics.join('\n')}`);
  }
  return {
    path,
    sourceFile,
  };
}

function visit(node: ts.Node, visitor: (node: ts.Node) => void) {
  visitor(node);
  ts.forEachChild(node, (child) => visit(child, visitor));
}

function collectNodes<T extends ts.Node>(node: ts.Node, predicate: (node: ts.Node) => node is T) {
  const matches: T[] = [];
  visit(node, (candidate) => {
    if (predicate(candidate)) matches.push(candidate);
  });
  return matches;
}

function isFunctionLikeNode(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isArrowFunction(node)
    || ts.isFunctionExpression(node)
    || ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node);
}

function nearestFunctionLikeAncestor(node: ts.Node) {
  let current = node.parent;
  while (current) {
    if (isFunctionLikeNode(current)) return current;
    current = current.parent;
  }
}

function collectOwnedNodes<T extends ts.Node>(
  owner: ts.FunctionLikeDeclaration,
  predicate: (node: ts.Node) => node is T,
) {
  return collectNodes(owner, predicate).filter((node) => nearestFunctionLikeAncestor(node) === owner);
}

function compactNode(node: ts.Node) {
  return node.getText(node.getSourceFile()).replace(/\s+/g, ' ').trim();
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isExported(node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function findNamedFunction(parsed: ParsedSource, name: string, exported = false) {
  const matches = collectNodes(
    parsed.sourceFile,
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name
      && (!exported || isExported(node)),
  );
  assert.equal(matches.length, 1, `Expected one ${exported ? 'exported ' : ''}${name} function in ${parsed.path}`);
  assert.ok(matches[0].body, `${name} must have a body`);
  return matches[0];
}

function findCatchClause(intendedFunction: ts.FunctionLikeDeclaration) {
  assert.ok(intendedFunction.body && ts.isBlock(intendedFunction.body));
  const matches = collectOwnedNodes(intendedFunction, ts.isCatchClause).filter(
    (clause) => ts.isTryStatement(clause.parent) && clause.parent.parent === intendedFunction.body,
  );
  assert.equal(matches.length, 1, 'Expected exactly one top-level catch clause owned by the intended function');
  return matches[0];
}

function findIfStatement(boundary: ts.Node, predicate: (expression: ts.Expression) => boolean) {
  const matches = collectNodes(
    boundary,
    (node): node is ts.IfStatement => ts.isIfStatement(node) && predicate(node.expression),
  );
  assert.equal(matches.length, 1, 'Expected exactly one matching if statement');
  return matches[0];
}

function findDefaultClause(boundary: ts.Node) {
  const matches = collectNodes(boundary, ts.isDefaultClause);
  assert.equal(matches.length, 1, 'Expected exactly one switch default clause');
  return matches[0];
}

function memberName(expression: ts.LeftHandSideExpression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (!ts.isElementAccessExpression(expression) || !expression.argumentExpression) return;
  const argument = unwrapParentheses(expression.argumentExpression);
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text;
}

function memberReceiver(expression: ts.LeftHandSideExpression) {
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return unwrapParentheses(expression.expression);
  }
}

function isMemberCall(call: ts.CallExpression, receiver: string, method: string) {
  const calledReceiver = memberReceiver(call.expression);
  return calledReceiver !== undefined
    && ts.isIdentifier(calledReceiver)
    && calledReceiver.text === receiver
    && memberName(call.expression) === method;
}

function returnedMemberCalls(boundary: ts.Node, receiver: string, method: string) {
  const calls: ts.CallExpression[] = [];
  for (const statement of collectNodes(boundary, ts.isReturnStatement)) {
    if (!statement.expression) continue;
    const expression = unwrapParentheses(statement.expression);
    if (ts.isCallExpression(expression) && isMemberCall(expression, receiver, method)) calls.push(expression);
  }
  return calls;
}

function handlerLevelReturns(handler: ts.FunctionLikeDeclaration) {
  return collectOwnedNodes(handler, ts.isReturnStatement);
}

function directStatement(node: ts.Node, block: ts.Block) {
  let current = node;
  while (current.parent && current.parent !== block) current = current.parent;
  return current.parent === block ? current : undefined;
}

function hasConditionalAncestor(node: ts.Node, boundary: ts.Node) {
  let current = node;
  while (current.parent && current.parent !== boundary) {
    const parent = current.parent;
    if (
      ts.isIfStatement(parent)
      || ts.isSwitchStatement(parent)
      || ts.isCaseClause(parent)
      || ts.isDefaultClause(parent)
      || ts.isForStatement(parent)
      || ts.isForInStatement(parent)
      || ts.isForOfStatement(parent)
      || ts.isWhileStatement(parent)
      || ts.isDoStatement(parent)
      || ts.isTryStatement(parent)
      || ts.isCatchClause(parent)
      || ts.isConditionalExpression(parent)
      || (ts.isBinaryExpression(parent) && [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(parent.operatorToken.kind))
    ) {
      return true;
    }
    current = parent;
  }
  return false;
}

function resolveReturnedIdentifier(
  handler: ts.FunctionLikeDeclaration,
  statement: ts.ReturnStatement,
  identifier: string,
) {
  assert.ok(ts.isBlock(statement.parent), `Returned identifier ${identifier} must be in a block`);
  const block = statement.parent;
  const returnIndex = block.statements.indexOf(statement);
  assert.notEqual(returnIndex, -1);

  const definitions: Array<{
    node: ts.Node;
    expression?: ts.Expression;
    conditional: boolean;
  }> = [];
  for (const candidate of collectOwnedNodes(handler, ts.isVariableDeclaration)) {
    const statementNode = directStatement(candidate, block);
    if (
      taintTargets(candidate.name).some((target) => target.name === identifier)
      && statementNode
      && block.statements.indexOf(statementNode as ts.Statement) < returnIndex
    ) {
      definitions.push({
        node: candidate,
        expression: ts.isIdentifier(candidate.name) ? candidate.initializer : undefined,
        conditional: hasConditionalAncestor(candidate, block),
      });
    }
  }
  for (const candidate of collectOwnedNodes(handler, ts.isBinaryExpression)) {
    const left = unwrapParentheses(candidate.left);
    const writesIdentifier = taintTargets(candidate.left).some((target) => target.name === identifier);
    const statementNode = directStatement(candidate, block);
    if (
      isAssignmentOperator(candidate.operatorToken.kind)
      && writesIdentifier
      && statementNode
      && block.statements.indexOf(statementNode as ts.Statement) < returnIndex
    ) {
      definitions.push({
        node: candidate,
        expression: candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isIdentifier(left)
          && left.text === identifier
          ? candidate.right
          : undefined,
        conditional: hasConditionalAncestor(candidate, block),
      });
    }
  }
  for (const candidate of collectOwnedNodes(
    handler,
    (node): node is ts.PrefixUnaryExpression | ts.PostfixUnaryExpression => (
      ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)
    ),
  )) {
    const statementNode = directStatement(candidate, block);
    if (
      taintTargets(candidate.operand).some((target) => target.name === identifier)
      && statementNode
      && block.statements.indexOf(statementNode as ts.Statement) < returnIndex
    ) {
      definitions.push({
        node: candidate,
        conditional: hasConditionalAncestor(candidate, block),
      });
    }
  }

  definitions.sort((left, right) => left.node.getStart() - right.node.getStart());
  const latestUnconditional = definitions.filter((definition) => !definition.conditional).at(-1);
  const candidates = latestUnconditional
    ? definitions.filter((definition) => (
        definition === latestUnconditional
        || (definition.conditional && definition.node.getStart() > latestUnconditional.node.getStart())
      ))
    : definitions;
  assert.ok(candidates.length > 0, `Returned identifier ${identifier} has no owned reaching definition`);
  assert.ok(
    candidates.every((definition) => definition.expression),
    `Returned identifier ${identifier} has an unresolved or ambiguous reaching definition`,
  );
  const expressions = candidates.map((definition) => definition.expression as ts.Expression);
  const canonical = compactNode(expressions[0]);
  assert.ok(
    expressions.every((expression) => compactNode(expression) === canonical),
    `Returned identifier ${identifier} has divergent possible reaching definitions`,
  );
  return expressions;
}

function resolveHandlerReturnExpression(
  handler: ts.FunctionLikeDeclaration,
  statement: ts.ReturnStatement,
  candidate: ts.Expression,
  receiver: string,
  method: string,
  resolvingIdentifiers = new Set<string>(),
): ts.CallExpression[] {
  const expression = unwrapParentheses(candidate);

  if (ts.isCallExpression(expression)) {
    assert.ok(
      isMemberCall(expression, receiver, method),
      `Handler return call must be ${receiver}.${method}: ${compactNode(expression)}`,
    );
    return [expression];
  }

  if (ts.isIdentifier(expression)) {
    assert.ok(
      !resolvingIdentifiers.has(expression.text),
      `Returned identifier ${expression.text} has a cyclic reaching definition`,
    );
    const nextIdentifiers = new Set(resolvingIdentifiers).add(expression.text);
    return resolveReturnedIdentifier(handler, statement, expression.text).flatMap((resolved) => (
      resolveHandlerReturnExpression(
        handler,
        statement,
        resolved,
        receiver,
        method,
        nextIdentifiers,
      )
    ));
  }

  if (ts.isConditionalExpression(expression)) {
    return [expression.whenTrue, expression.whenFalse].flatMap((branch) => (
      resolveHandlerReturnExpression(handler, statement, branch, receiver, method, resolvingIdentifiers)
    ));
  }

  if (ts.isAwaitExpression(expression)) {
    return resolveHandlerReturnExpression(
      handler,
      statement,
      expression.expression,
      receiver,
      method,
      resolvingIdentifiers,
    );
  }

  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    if ([
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(operator)) {
      assert.fail(`Unsupported logical handler return expression: ${compactNode(expression)}`);
    }
    if (operator === ts.SyntaxKind.CommaToken) {
      assert.fail(`Unsupported comma handler return expression: ${compactNode(expression)}`);
    }
  }

  assert.fail(
    `Unsupported handler return-expression kind ${ts.SyntaxKind[expression.kind]}: ${compactNode(expression)}`,
  );
}

function handlerReturnedMemberCalls(
  handler: ts.FunctionLikeDeclaration,
  receiver: string,
  method: string,
) {
  const calls: ts.CallExpression[] = [];
  for (const statement of handlerLevelReturns(handler)) {
    assert.ok(statement.expression, 'Handler return statements must return an accepted response expression');
    calls.push(...resolveHandlerReturnExpression(
      handler,
      statement,
      statement.expression,
      receiver,
      method,
    ));
  }
  return calls;
}

function namedCalls(boundary: ts.Node, name: string) {
  return collectNodes(
    boundary,
    (node): node is ts.CallExpression => ts.isCallExpression(node)
      && ts.isIdentifier(unwrapParentheses(node.expression))
      && (unwrapParentheses(node.expression) as ts.Identifier).text === name,
  );
}

function dottedName(expression: ts.Expression): string | undefined {
  const unwrapped = unwrapParentheses(expression);
  if (ts.isIdentifier(unwrapped)) return unwrapped.text;
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const receiver = dottedName(unwrapped.expression);
    return receiver ? `${receiver}.${unwrapped.name.text}` : undefined;
  }
}

function dottedCalls(boundary: ts.Node, name: string) {
  return collectNodes(
    boundary,
    (node): node is ts.CallExpression => ts.isCallExpression(node) && dottedName(node.expression) === name,
  );
}

function isAssignmentOperator(kind: ts.SyntaxKind) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function assertStaticLog(boundary: ts.Node, method: 'error' | 'log' | 'warn', label: string) {
  const owner = isFunctionLikeNode(boundary) ? boundary : nearestFunctionLikeAncestor(boundary);
  assert.ok(owner, 'Protected console boundary must have an intended function-like owner');
  const verifiedOwner = owner;
  const boundaryOwnedNodes = <T extends ts.Node>(predicate: (node: ts.Node) => node is T) => (
    collectNodes(boundary, predicate).filter((node) => nearestFunctionLikeAncestor(node) === owner)
  );
  const ownerOwnedNodes = <T extends ts.Node>(predicate: (node: ts.Node) => node is T) => (
    collectOwnedNodes(owner, predicate)
  );

  function definitionIsConditional(node: ts.Node) {
    let current: ts.Node | undefined = node;
    while (current && current !== owner) {
      if (current === boundary) return hasConditionalAncestor(node, boundary);
      current = current.parent;
    }
    return hasConditionalAncestor(node, verifiedOwner);
  }

  function aliasStateAt(identifier: string, call: ts.CallExpression) {
    const definitions: Array<{
      node: ts.Node;
      expression?: ts.Expression;
      conditional: boolean;
    }> = [];
    for (const declaration of ownerOwnedNodes(ts.isVariableDeclaration)) {
      if (
        declaration.getStart() < call.getStart()
        && ts.isIdentifier(declaration.name)
        && declaration.name.text === identifier
      ) {
        definitions.push({
          node: declaration,
          expression: declaration.initializer,
          conditional: definitionIsConditional(declaration),
        });
      }
    }
    for (const assignment of ownerOwnedNodes(ts.isBinaryExpression)) {
      const left = unwrapParentheses(assignment.left);
      if (
        assignment.getStart() < call.getStart()
        && isAssignmentOperator(assignment.operatorToken.kind)
        && ts.isIdentifier(left)
        && left.text === identifier
      ) {
        definitions.push({
          node: assignment,
          expression: [
            ts.SyntaxKind.EqualsToken,
            ts.SyntaxKind.BarBarEqualsToken,
            ts.SyntaxKind.QuestionQuestionEqualsToken,
            ts.SyntaxKind.AmpersandAmpersandEqualsToken,
          ].includes(assignment.operatorToken.kind)
            ? assignment.right
            : undefined,
          conditional: definitionIsConditional(assignment)
            || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken,
        });
      }
    }
    for (const mutation of ownerOwnedNodes(
      (node): node is ts.PrefixUnaryExpression | ts.PostfixUnaryExpression => (
        ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)
      ),
    )) {
      if (
        mutation.getStart() < call.getStart()
        && ts.isIdentifier(mutation.operand)
        && mutation.operand.text === identifier
      ) {
        definitions.push({
          node: mutation,
          conditional: true,
        });
      }
    }
    definitions.sort((left, right) => left.node.getStart() - right.node.getStart());
    const latestUnconditional = definitions.filter((definition) => !definition.conditional).at(-1);
    return latestUnconditional
      ? definitions.filter((definition) => (
          definition === latestUnconditional
          || (definition.conditional && definition.node.getStart() > latestUnconditional.node.getStart())
        ))
      : definitions;
  }

  const calls = boundaryOwnedNodes(
    (node): node is ts.CallExpression => {
      if (!ts.isCallExpression(node)) return false;
      const receiver = memberReceiver(node.expression);
      if (receiver === undefined || !ts.isIdentifier(receiver)) return false;
      if (receiver.text === 'console') return true;
      const state = aliasStateAt(receiver.text, node);
      const consoleDefinitions = state.filter((definition) => (
        definition.expression
        && isIdentifier(definition.expression, 'console')
      ));
      const unresolvedDefinitions = state.filter((definition) => !definition.expression);
      if (consoleDefinitions.length === 0) {
        assert.equal(
          unresolvedDefinitions.length,
          0,
          `Console alias ${receiver.text} has an unresolved or ambiguous reaching definition`,
        );
        return false;
      }
      assert.equal(
        consoleDefinitions.length,
        state.length,
        `Console alias ${receiver.text} has ambiguous reaching definitions`,
      );
      return true;
    },
  );

  assert.equal(calls.length, 1, `Expected exactly one console call in the protected boundary: ${label}`);
  const resolvedMethod = memberName(calls[0].expression);
  assert.ok(resolvedMethod, 'Console method name must resolve statically');
  assert.equal(resolvedMethod, method);
  assert.equal(calls[0].arguments.length, 1);
  const argument = unwrapParentheses(calls[0].arguments[0]);
  assert.ok(
    ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument),
    'Console argument must be a static string or no-substitution template',
  );
  assert.equal(argument.text, label);
}

function findEstablishedCatchCallback(parsed: ParsedSource, calleeName: string) {
  const matches = collectNodes(
    parsed.sourceFile,
    (node): node is ts.CallExpression => {
      if (!ts.isCallExpression(node) || memberName(node.expression) !== 'catch') return false;
      const receiver = memberReceiver(node.expression);
      return receiver !== undefined
        && ts.isCallExpression(receiver)
        && ts.isIdentifier(unwrapParentheses(receiver.expression))
        && (unwrapParentheses(receiver.expression) as ts.Identifier).text === calleeName;
    },
  );
  assert.equal(matches.length, 1, `Expected one ${calleeName}().catch() callback`);
  assert.equal(matches[0].arguments.length, 1);
  const callback = unwrapParentheses(matches[0].arguments[0]);
  assert.ok(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback));
  return callback;
}

function propertyNameText(name: ts.PropertyName) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapParentheses(name.expression);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  }
}

function isIdentifier(expression: ts.Expression, name: string) {
  const unwrapped = unwrapParentheses(expression);
  return ts.isIdentifier(unwrapped) && unwrapped.text === name;
}

function isDirectProperty(expression: ts.Expression, receiver: string, property: string) {
  const unwrapped = unwrapParentheses(expression);
  return ts.isPropertyAccessExpression(unwrapped)
    && isIdentifier(unwrapped.expression, receiver)
    && unwrapped.name.text === property;
}

const publicAccountFields = [
  'id', 'platform', 'platformAccountId', 'platformAccountName', 'platformAccountUsername',
  'platformAccountImage', 'expiresAt', 'createdAt', 'publishable', 'publishBlockedReason',
] as const;

const directAccountFields = [
  'id', 'platform', 'platformAccountId', 'platformAccountName', 'platformAccountUsername',
  'platformAccountImage', 'expiresAt', 'createdAt',
] as const;

function mapReceiver(expression: ts.Expression, method: string) {
  const unwrapped = unwrapParentheses(expression);
  if (!ts.isCallExpression(unwrapped) || memberName(unwrapped.expression) !== method) return;
  return { call: unwrapped, receiver: memberReceiver(unwrapped.expression) };
}

function sensitiveNamesIn(node: ts.Node, tainted: ReadonlySet<string>) {
  let sensitive = false;
  visit(node, (candidate) => {
    if (!ts.isIdentifier(candidate)) return;
    const name = candidate.text;
    if (
      tainted.has(name)
      || /account|token|credential/i.test(name)
      || ['provider', 'profile'].includes(name)
    ) {
      sensitive = true;
    }
  });
  return sensitive;
}

type TaintTarget = {
  name: string;
  sensitiveProperty: boolean;
};

function sensitivePropertyName(name: ts.PropertyName | undefined) {
  const text = name && propertyNameText(name);
  return text !== undefined && /account|token|credential/i.test(text);
}

function taintTargets(node: ts.Node, inheritedSensitive = false): TaintTarget[] {
  if (ts.isIdentifier(node)) {
    return [{ name: node.text, sensitiveProperty: inheritedSensitive }];
  }
  if (ts.isParenthesizedExpression(node)) {
    return taintTargets(node.expression, inheritedSensitive);
  }
  if (ts.isObjectBindingPattern(node)) {
    return node.elements.flatMap((element) => taintTargets(
      element.name,
      inheritedSensitive || sensitivePropertyName(element.propertyName),
    ));
  }
  if (ts.isArrayBindingPattern(node)) {
    return node.elements.flatMap((element) => ts.isBindingElement(element)
      ? taintTargets(element.name, inheritedSensitive)
      : []);
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.flatMap((property) => {
      if (ts.isPropertyAssignment(property)) {
        return taintTargets(
          property.initializer,
          inheritedSensitive || sensitivePropertyName(property.name),
        );
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return taintTargets(
          property.name,
          inheritedSensitive || sensitivePropertyName(property.name),
        );
      }
      if (ts.isSpreadAssignment(property)) return taintTargets(property.expression, inheritedSensitive);
      return [];
    });
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element) => ts.isOmittedExpression(element)
      ? []
      : taintTargets(element, inheritedSensitive));
  }
  return [];
}

function propertyMutationTarget(node: ts.Expression) {
  let current = unwrapParentheses(node);
  let hasProperty = false;
  let unresolvedProperty = false;
  let hasSensitiveProperty = false;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    hasProperty = true;
    let property: string | undefined;
    if (ts.isPropertyAccessExpression(current)) {
      property = current.name.text;
    } else if (current.argumentExpression) {
      const argument = unwrapParentheses(current.argumentExpression);
      if (
        ts.isStringLiteral(argument)
        || ts.isNoSubstitutionTemplateLiteral(argument)
        || ts.isNumericLiteral(argument)
      ) {
        property = argument.text;
      }
    }
    unresolvedProperty ||= property === undefined;
    hasSensitiveProperty ||= property !== undefined && /account|token|credential/i.test(property);
    current = unwrapParentheses(current.expression);
  }
  if (!hasProperty || !ts.isIdentifier(current)) return;
  return {
    name: current.text,
    unresolvedProperty,
    hasSensitiveProperty,
  };
}

function isFixedSafeMutationValue(node: ts.Expression): boolean {
  const expression = unwrapParentheses(node);
  if (
    ts.isStringLiteral(expression)
    || ts.isNoSubstitutionTemplateLiteral(expression)
    || ts.isNumericLiteral(expression)
    || expression.kind === ts.SyntaxKind.TrueKeyword
    || expression.kind === ts.SyntaxKind.FalseKeyword
    || expression.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (
    ts.isPrefixUnaryExpression(expression)
    && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(expression.operator)
    && ts.isNumericLiteral(unwrapParentheses(expression.operand))
  ) {
    return true;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.every((element) => (
      ts.isOmittedExpression(element) || isFixedSafeMutationValue(element)
    ));
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.every((property) => (
      ts.isPropertyAssignment(property)
      && propertyNameText(property.name) !== undefined
      && isFixedSafeMutationValue(property.initializer)
    ));
  }
  return false;
}

function taintedLocals(handler: ts.FunctionLikeDeclaration) {
  const definitions: Array<{
    targets: TaintTarget[];
    sources: ts.Node[];
    ambiguous: boolean;
  }> = [];
  const aliasPairs: Array<readonly [string, string]> = [];
  for (const declaration of collectOwnedNodes(handler, ts.isVariableDeclaration)) {
    definitions.push({
      targets: taintTargets(declaration.name),
      sources: declaration.initializer ? [declaration.initializer] : [],
      ambiguous: false,
    });
    if (
      ts.isIdentifier(declaration.name)
      && declaration.initializer
      && ts.isIdentifier(unwrapParentheses(declaration.initializer))
    ) {
      aliasPairs.push([
        declaration.name.text,
        (unwrapParentheses(declaration.initializer) as ts.Identifier).text,
      ]);
    }
  }
  for (const assignment of collectOwnedNodes(handler, ts.isBinaryExpression)) {
    if (!isAssignmentOperator(assignment.operatorToken.kind)) continue;
    const mutationTarget = propertyMutationTarget(assignment.left);
    if (mutationTarget) {
      definitions.push({
        targets: [{
          name: mutationTarget.name,
          sensitiveProperty: mutationTarget.hasSensitiveProperty,
        }],
        sources: [assignment.right],
        ambiguous: assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken
          || mutationTarget.unresolvedProperty
          || !isFixedSafeMutationValue(assignment.right),
      });
      continue;
    }
    definitions.push({
      targets: taintTargets(assignment.left),
      sources: [assignment.right],
      ambiguous: assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken,
    });
    const left = unwrapParentheses(assignment.left);
    const right = unwrapParentheses(assignment.right);
    if (
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(left)
      && ts.isIdentifier(right)
    ) {
      aliasPairs.push([left.text, right.text]);
    }
  }
  for (const mutation of collectOwnedNodes(
    handler,
    (node): node is ts.PrefixUnaryExpression | ts.PostfixUnaryExpression => (
      ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)
    ),
  )) {
    const mutationTarget = propertyMutationTarget(mutation.operand);
    definitions.push({
      targets: mutationTarget
        ? [{ name: mutationTarget.name, sensitiveProperty: true }]
        : taintTargets(mutation.operand),
      sources: [],
      ambiguous: true,
    });
  }
  for (const call of collectOwnedNodes(handler, ts.isCallExpression)) {
    if (!isMemberCall(call, 'Object', 'assign') || call.arguments.length === 0) continue;
    const target = unwrapParentheses(call.arguments[0]);
    if (!ts.isIdentifier(target)) continue;
    const sources = [...call.arguments.slice(1)];
    definitions.push({
      targets: [{ name: target.text, sensitiveProperty: false }],
      sources,
      ambiguous: sources.length === 0 || sources.some((source) => !isFixedSafeMutationValue(source)),
    });
  }

  const tainted = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const definition of definitions) {
      const sourceIsSensitive = definition.sources.some((source) => sensitiveNamesIn(source, tainted));
      for (const target of definition.targets) {
        if (
          !tainted.has(target.name)
          && (
            definition.ambiguous
            || target.sensitiveProperty
            || /account|token|credential/i.test(target.name)
            || sourceIsSensitive
          )
        ) {
          tainted.add(target.name);
          changed = true;
        }
      }
    }
    for (const [left, right] of aliasPairs) {
      if (tainted.has(left) === tainted.has(right)) continue;
      tainted.add(left);
      tainted.add(right);
      changed = true;
    }
  }
  return tainted;
}

function assertAccountSuccessResponse(call: ts.CallExpression) {
  assert.equal(call.arguments.length, 1, 'Account success response must have one argument');
  const response = unwrapParentheses(call.arguments[0]);
  assert.ok(ts.isObjectLiteralExpression(response), 'Account response must be a direct object literal');
  assert.equal(response.properties.length, 1, 'Account response must contain only accounts');
  const accountsProperty = response.properties[0];
  assert.ok(ts.isPropertyAssignment(accountsProperty), 'accounts must be an explicit property assignment');
  assert.ok(ts.isIdentifier(accountsProperty.name) && accountsProperty.name.text === 'accounts');

  const map = mapReceiver(accountsProperty.initializer, 'map');
  assert.ok(map?.receiver, 'accounts must serialize a direct map call');
  assert.equal(map.call.arguments.length, 1);
  const filter = mapReceiver(map.receiver, 'filter');
  assert.ok(filter?.receiver, 'map must be connected to the approved filter call');
  assert.ok(isIdentifier(filter.receiver, 'accounts'), 'filter must operate on the accounts collection');
  assert.equal(filter.call.arguments.length, 1);

  const filterCallback = unwrapParentheses(filter.call.arguments[0]);
  assert.ok(ts.isArrowFunction(filterCallback), 'Account filter must use the production arrow callback');
  assert.equal(filterCallback.parameters.length, 1);
  assert.ok(ts.isIdentifier(filterCallback.parameters[0].name));
  const filterParameter = filterCallback.parameters[0].name.text;
  assert.equal(filterParameter, 'account');
  assert.ok(!ts.isBlock(filterCallback.body), 'Account filter must return the predicate expression directly');
  const filterPredicate = unwrapParentheses(filterCallback.body);
  assert.ok(ts.isCallExpression(filterPredicate));
  assert.ok(ts.isIdentifier(unwrapParentheses(filterPredicate.expression)));
  assert.equal((unwrapParentheses(filterPredicate.expression) as ts.Identifier).text, 'isSupportedSocialAccountPlatform');
  assert.equal(filterPredicate.arguments.length, 1);
  assert.ok(isDirectProperty(filterPredicate.arguments[0], filterParameter, 'platform'));

  const mapCallback = unwrapParentheses(map.call.arguments[0]);
  assert.ok(ts.isArrowFunction(mapCallback), 'Account map must use an arrow callback');
  assert.equal(mapCallback.parameters.length, 1);
  assert.ok(ts.isIdentifier(mapCallback.parameters[0].name));
  const accountParameter = mapCallback.parameters[0].name.text;
  assert.equal(accountParameter, 'account');
  assert.ok(ts.isBlock(mapCallback.body), 'Account map callback must have an explicit body');
  assert.equal(mapCallback.body.statements.length, 2, 'Account map callback must contain only the approved derivation and return');

  const derivation = mapCallback.body.statements[0];
  assert.ok(ts.isVariableStatement(derivation));
  assert.ok((derivation.declarationList.flags & ts.NodeFlags.Const) !== 0);
  assert.equal(derivation.declarationList.declarations.length, 1);
  const declaration = derivation.declarationList.declarations[0];
  assert.ok(ts.isIdentifier(declaration.name) && declaration.name.text === 'publishBlockedReason');
  assert.ok(declaration.initializer && ts.isCallExpression(unwrapParentheses(declaration.initializer)));
  const derivationCall = unwrapParentheses(declaration.initializer) as ts.CallExpression;
  assert.ok(ts.isIdentifier(unwrapParentheses(derivationCall.expression)));
  assert.equal((unwrapParentheses(derivationCall.expression) as ts.Identifier).text, 'getLinkedAccountPublishBlockedReason');
  assert.equal(derivationCall.arguments.length, 1);
  assert.ok(isIdentifier(derivationCall.arguments[0], accountParameter));

  const returnedProjection = mapCallback.body.statements[1];
  assert.ok(ts.isReturnStatement(returnedProjection) && returnedProjection.expression);
  const projection = unwrapParentheses(returnedProjection.expression);
  assert.ok(ts.isObjectLiteralExpression(projection), 'Account map must return a direct object literal');
  assert.equal(projection.properties.length, publicAccountFields.length);

  const fields = new Map<string, ts.ObjectLiteralElementLike>();
  for (const property of projection.properties) {
    assert.ok(
      ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property),
      'Mapped account fields cannot use spreads, methods, or computed declarations',
    );
    assert.ok(!ts.isComputedPropertyName(property.name), 'Mapped account keys cannot be computed');
    const key = propertyNameText(property.name);
    assert.ok(key && publicAccountFields.includes(key as typeof publicAccountFields[number]), `Unexpected account key: ${key}`);
    assert.ok(!fields.has(key), `Duplicate account key: ${key}`);
    fields.set(key, property);
  }
  assert.deepEqual([...fields.keys()].sort(), [...publicAccountFields].sort());

  for (const field of directAccountFields) {
    const property = fields.get(field);
    assert.ok(property && ts.isPropertyAssignment(property), `${field} must be an explicit property assignment`);
    assert.ok(isDirectProperty(property.initializer, accountParameter, field), `${field} must use account.${field}`);
  }

  const publishable = fields.get('publishable');
  assert.ok(publishable && ts.isPropertyAssignment(publishable));
  const publishableExpression = unwrapParentheses(publishable.initializer);
  assert.ok(ts.isBinaryExpression(publishableExpression));
  assert.equal(publishableExpression.operatorToken.kind, ts.SyntaxKind.EqualsEqualsEqualsToken);
  assert.ok(isIdentifier(publishableExpression.left, 'publishBlockedReason'));
  assert.equal(unwrapParentheses(publishableExpression.right).kind, ts.SyntaxKind.NullKeyword);

  const publishBlockedReason = fields.get('publishBlockedReason');
  assert.ok(publishBlockedReason && ts.isShorthandPropertyAssignment(publishBlockedReason));
  assert.equal(publishBlockedReason.name.text, 'publishBlockedReason');
  assert.equal(publishBlockedReason.objectAssignmentInitializer, undefined);
}

function assertLinkedAccountSerialization(parsed: ParsedSource) {
  const getHandler = findNamedFunction(parsed, 'GET', true);
  const responses = handlerReturnedMemberCalls(getHandler, 'NextResponse', 'json');
  const accountCandidates = responses.filter((call) => {
    if (call.arguments.length === 0) return false;
    const response = unwrapParentheses(call.arguments[0]);
    return ts.isObjectLiteralExpression(response)
      && response.properties.some((property) => property.name && propertyNameText(property.name) === 'accounts');
  });
  assert.ok(accountCandidates.length > 0, 'Expected at least one account-bearing success response');
  for (const successResponse of accountCandidates) assertAccountSuccessResponse(successResponse);

  const tainted = taintedLocals(getHandler);
  const successResponses = new Set(accountCandidates);
  for (const response of responses) {
    if (successResponses.has(response) || response.arguments.length === 0) continue;
    assert.equal(
      sensitiveNamesIn(response.arguments[0], tainted),
      false,
      'Alternate JSON responses must not serialize account, provider, credential, token, or unchecked projection data',
    );
  }
}

function assertRedirect(boundary: ts.Node, redirect: string) {
  const calls = returnedMemberCalls(boundary, 'NextResponse', 'redirect');
  assert.equal(calls.length, 1, `Expected one redirect for ${redirect}`);
  assert.equal(calls[0].arguments.length, 1);
  assert.equal(compactNode(calls[0].arguments[0]), `new URL('/dashboard?error=${redirect}', request.url)`);
  const forbidden = new Set(['error', 'errorText', 'code', 'state', 'accessToken', 'refreshToken', 'tokenData']);
  const forbiddenReferences = collectNodes(
    calls[0].arguments[0],
    (node): node is ts.Identifier => ts.isIdentifier(node)
      && (forbidden.has(node.text) || ['provider', 'tokenRes'].includes(node.text)),
  );
  assert.equal(forbiddenReferences.length, 0);
}

function assertReturnedCallArguments(
  boundary: ts.Node,
  receiver: string,
  method: string,
  expected: readonly string[],
) {
  const calls = returnedMemberCalls(boundary, receiver, method);
  assert.equal(calls.length, 1, `Expected one returned ${receiver}.${method} call`);
  assert.deepEqual(calls[0].arguments.map(compactNode), expected);
}

test('S4b log-call extraction ignores inert source text and rejects unsafe calls', () => {
  function targetBoundary(source: string) {
    return findNamedFunction(parseSource(source), 'target');
  }

  assert.throws(
    () => parseSource('function target( {', 'malformed-fixture.ts'),
    /malformed-fixture\.ts:\d+:\d+ TS\d+:/,
  );

  for (const accepted of [
    "function target() { console.error('Accepted static label'); }",
    'function target() { console.error(`Accepted static label`); }',
    "function target() { console['error']('Accepted static label'); }",
    'function target() { console[`error`](`Accepted static label`); }',
    "function target() { const logger = console; logger.error('Accepted static label'); }",
    "function target() { let logger; logger = console; logger.error('Accepted static label'); }",
    `function target() {
      const quoted = "console.error(error)";
      const inertTemplate = \`console.warn(\${'inert text only'})\`;
      const pattern = /console\\.error\\(\\{.*\\}\\)/;
      // console.info(error)
      /* console.debug(error) */
      console.error('Accepted static label');
    }`,
  ]) {
    assertStaticLog(targetBoundary(accepted), 'error', 'Accepted static label');
  }

  for (const fixture of [
    "function target() { const text = \"console.error('Accepted static label')\"; }",
    "function target() { /* console.error('Accepted static label') */ }",
    "function target() { `console.error(error)`; }",
    'function target() { console.error(error); }',
    "function target() { console.error('Accepted static label', error); }",
    'function target() { console.error(`Failure: ${error.message}`); }',
    'function target() { `${console.error(error)}`; }',
    'function target() { const logger = console; logger.error(error); }',
    "function target() { console['error'](error); }",
    'function target() { console[`error`](error); }',
    "function target() { console.error('Accepted static label'); const logger = console; logger.error(errorText); }",
    'function target() { console.warn(error); }',
    'function target() { console.info(error); }',
    'function target() { const logger = console; logger.warn(error); }',
    "function target() { console['warn'](error); }",
    "function target() { console.error('Accepted static label'); console.debug(error); }",
    'function target() { console[method](secret); }',
    'function target() { const logger = console; logger[method](secret); }',
    "function target() { console.error('Accepted static label'); console[method](secret); }",
    "function target() { // }\n console.warn(error); }",
    "function target() { /* } */ console.warn(error); }",
    'function target() { const pattern = /}/g; console.warn(error); }',
    'function target() { return /console\\.error\\(\\{.*\\}\\)/; console.warn(error); }',
    `function target() {
      \`\${(() => {
        const logger = console;
        logger.error(error);
      })()}\`;
    }`,
    "function target() { console/* comment-separated member */.error(error); }",
    `function target() {
      let logger = console;
      logger = replacement;
      logger.error('Accepted static label');
    }`,
    `function target() {
      let logger;
      logger = console;
      logger.error(error);
    }`,
    `function target() {
      let logger;
      logger = console;
      logger[method](secret);
    }`,
    `function target() {
      console.error('Accepted static label');
      let logger;
      logger = console;
      logger.warn(error);
    }`,
    `function target() {
      let logger = console;
      if (condition) {
        logger = otherLogger;
      }
      logger.error(error);
    }`,
  ]) {
    assert.throws(() => assertStaticLog(targetBoundary(fixture), 'error', 'Accepted static label'));
  }

  const unrelated = parseSource(
    "function target() { console.error(error); } function unrelated() { console.error('Accepted static label'); }",
  );
  assert.throws(() => assertStaticLog(
    findNamedFunction(unrelated, 'target'),
    'error',
    'Accepted static label',
  ));

  const misleadingCatch = targetBoundary(`function target() {
    try {
      return /catch\\s*\\{[^}]*console\\.error/;
    } catch (error) {
      // catch { console.error('Accepted static label'); }
      console.warn(error);
    }
  }`);
  assert.throws(() => assertStaticLog(findCatchClause(misleadingCatch), 'error', 'Accepted static label'));

  for (const nestedCatchDecoy of [
    `async function target() {
      async function nested() {
        try {
          work();
        } catch {
          console.error('Accepted static label');
        }
      }

      console.error(error);
    }`,
    `async function target() {
      values.forEach(() => {
        try {
          work();
        } catch {
          console.error('Accepted static label');
        }
      });

      console.error(error);
    }`,
    `async function target() {
      try {
        work();
      } catch (error) {
        values.forEach(() => {
          try {
            work();
          } catch {
            console.error('Accepted static label');
          }
        });
        console.error(error);
      }
    }`,
    `async function target() {
      try {
        work();
      } catch {
        function nested() {
          console.error('Accepted static label');
        }

        console.error(error);
      }
    }`,
    `async function target() {
      try {
        work();
      } catch {
        items.forEach(() => {
          console.error('Accepted static label');
        });

        leak(error);
      }
    }`,
    `async function target() {
      try {
        work();
      } catch {
        const nested = () => console.error('Accepted static label');
        console.warn(error);
      }
    }`,
  ]) {
    assert.throws(() => assertStaticLog(
      findCatchClause(targetBoundary(nestedCatchDecoy)),
      'error',
      'Accepted static label',
    ));
  }

  const outerOwnedLog = targetBoundary(`async function target() {
    try {
      work();
    } catch {
      function nested() {
        const inert = 'unrelated';
      }

      console.error('Accepted static label');
    }
  }`);
  assertStaticLog(findCatchClause(outerOwnedLog), 'error', 'Accepted static label');

  const ownerWideAliasFixtures = [
    {
      source: `async function target() {
        let logger;
        logger = console;

        try {
          work();
        } catch {
          logger[method](secret);
        }
      }`,
      method: 'error' as const,
      error: /Console method name must resolve statically/,
    },
    {
      source: `async function target() {
        let logger = console;

        try {
          work();
        } catch {
          logger.warn(secret);
        }
      }`,
      method: 'warn' as const,
      error: /Console argument must be a static string/,
    },
  ];
  for (const fixture of ownerWideAliasFixtures) {
    assert.throws(
      () => assertStaticLog(
        findCatchClause(targetBoundary(fixture.source)),
        fixture.method,
        'Accepted static label',
      ),
      fixture.error,
    );
  }

  for (const fixture of [
    `function target() {
      let logger;
      logger ||= console;
      logger.error(secret);
    }`,
    `function target() {
      let logger;
      logger ??= console;
      logger[method](secret);
    }`,
    `function target() {
      let logger = otherLogger;
      logger &&= console;
      logger.warn(secret);
    }`,
  ]) {
    assert.throws(
      () => assertStaticLog(targetBoundary(fixture), 'error', 'Accepted static label'),
      /Console alias logger has ambiguous reaching definitions/,
    );
  }

  const nestedAliasDefinition = targetBoundary(`async function target() {
    const logger = otherLogger;
    function configureLogger() {
      logger = console;
    }

    try {
      work();
    } catch {
      logger.warn(secret);
      console.error('Accepted static label');
    }
  }`);
  assertStaticLog(findCatchClause(nestedAliasDefinition), 'error', 'Accepted static label');

  const unrelatedOwnerDefinition = targetBoundary(`async function target() {
    const logger = otherLogger;

    try {
      work();
    } catch {
      logger.warn(secret);
      console.error('Accepted static label');
    }
  }`);
  assertStaticLog(findCatchClause(unrelatedOwnerDefinition), 'error', 'Accepted static label');
});

test('S4b linked-account serialization is an exclusive public projection', () => {
  function linkedFixture(body: string) {
    return parseSource(`export async function GET() { ${body} }`, 'app/api/linked-accounts/route.ts');
  }

  const accepted = `return NextResponse.json({
    accounts: accounts.filter((account) => allowed(account.platform)).map((account) => {
      const publishBlockedReason = getLinkedAccountPublishBlockedReason(account);

      return {
        id: account.id,
        platform: account.platform,
        platformAccountId: account.platformAccountId,
        platformAccountName: account.platformAccountName,
        platformAccountUsername: account.platformAccountUsername,
        platformAccountImage: account.platformAccountImage,
        expiresAt: account.expiresAt,
        createdAt: account.createdAt,
        publishable: publishBlockedReason === null,
        publishBlockedReason,
      };
    }),
  });`;
  const productionAccepted = accepted.replace('allowed(account.platform)', 'isSupportedSocialAccountPlatform(account.platform)');
  const acceptedProjection = productionAccepted.match(/accounts: ([\s\S]+),\n  \}\);/)?.[1];
  assert.ok(acceptedProjection);
  const equivalentAcceptedProjection = acceptedProjection.replace(
    '        id: account.id,\n        platform: account.platform,',
    '        platform: account.platform,\n        id: account.id,',
  );
  assertLinkedAccountSerialization(linkedFixture(productionAccepted));
  assertLinkedAccountSerialization(linkedFixture(productionAccepted.replace(
    '        id: account.id,\n        platform: account.platform,',
    '        platform: account.platform,\n        id: account.id,',
  )));
  assertLinkedAccountSerialization(linkedFixture(`
    const nestedResponses = values.map(() => {
      const response = NextResponse.json({ rawAccounts: accounts });
      return response;
    });
    ${productionAccepted}
  `));
  assertLinkedAccountSerialization(linkedFixture(`
    ${productionAccepted}
    let response = NextResponse.json({ ok: true });
    if (condition) {
      response = NextResponse.json({ ok: true });
    }
    return response;
  `));
  assertLinkedAccountSerialization(linkedFixture(`
    ${productionAccepted}
    const payload = { ok: true };
    payload.status = 'ready';
    payload['count'] = 1;
    return NextResponse.json(payload);
  `));
  assertLinkedAccountSerialization(linkedFixture(`return condition
    ? NextResponse.json({ accounts: ${acceptedProjection} })
    : NextResponse.json({ accounts: ${equivalentAcceptedProjection} });`));
  assertLinkedAccountSerialization(linkedFixture(`return (NextResponse.json({
    accounts: ${acceptedProjection},
  }));`));

  for (const fixture of [
    `${productionAccepted}\nreturn NextResponse.json({ accounts });`,
    `if (false) { ${productionAccepted} }\nreturn NextResponse.json({ linkedAccounts: accounts });`,
    'return NextResponse.json({ accounts: accounts.filter((account) => isSupportedSocialAccountPlatform(account.platform)).map((account) => account) });',
    'return NextResponse.json({ accounts: accounts.filter((account) => { return isSupportedSocialAccountPlatform(account.platform); }).map((account) => account) });',
    productionAccepted.replace('  });', '    rawAccounts: accounts,\n  });'),
    'return NextResponse.json({ accounts });',
    'const projection = accounts; return NextResponse.json({ accounts: projection });',
    productionAccepted.replace('id: account.id,', '...account,'),
    productionAccepted.replace('        id: account.id,\n', ''),
    productionAccepted.replace('id: account.id,', 'id: account.id,\n        id: account.id,'),
    productionAccepted.replace('id: account.id,', "['id']: account.id,"),
    productionAccepted.replace('id: account.id,', 'id,'),
    productionAccepted.replace('id: account.id,', 'id() { return account.id; },'),
    productionAccepted.replace('publishable: publishBlockedReason === null,', 'publishable: publishBlockedReason === null,\n        displayName: account.displayName,'),
    productionAccepted.replace('  });', '    status: \'ok\',\n  });'),
    productionAccepted.replace('accounts:', "['accounts']:"),
    productionAccepted.replace('id: account.id,', 'id: account.accessToken,'),
    productionAccepted.replace('const publishBlockedReason = getLinkedAccountPublishBlockedReason(account);', 'const leakedValue = account.accessToken;\n      const publishBlockedReason = getLinkedAccountPublishBlockedReason(account);').replace('id: account.id,', 'id: leakedValue,'),
    productionAccepted.replace('id: account.id,', 'id: account,'),
    productionAccepted.replace('accounts: accounts.filter', 'accounts: projection.filter').replace('return NextResponse.json', 'const projection = accounts; return NextResponse.json'),
    `${productionAccepted}\nreturn NextResponse.json({ linkedAccounts: accounts });`,
    `${productionAccepted}\nreturn NextResponse.json({ account: accounts[0] });`,
    `${productionAccepted}\nreturn NextResponse.json(accounts);`,
    `${productionAccepted}\nreturn NextResponse.json({ data: provider });`,
    `${productionAccepted}\nreturn NextResponse.json({ data: credentials });`,
    `${productionAccepted}\nconst tokenPayload = account.accessToken; return NextResponse.json({ data: tokenPayload });`,
    `${productionAccepted}\nconst leak = accounts; return NextResponse.json({ data: leak });`,
    `${productionAccepted}\nlet leak = []; leak = accounts; return NextResponse.json({ data: leak });`,
    `${productionAccepted}\nlet leak; ({ accounts: leak } = source); return NextResponse.json({ data: leak });`,
    `${productionAccepted}\nconst { accessToken: leakedToken } = account; return NextResponse.json({ data: leakedToken });`,
    `${productionAccepted}\nlet token; token = account.refreshToken; return NextResponse.json({ data: token });`,
    `${productionAccepted}\nconst response = NextResponse.json({ rawAccounts: accounts }); return response;`,
    `${productionAccepted}\nlet response; response = NextResponse.json({ rawAccounts: accounts }); return response;`,
    `${productionAccepted}\nreturn condition
      ? NextResponse.json({ rawAccounts: accounts })
      : NextResponse.json({ ok: true });`,
    `return condition
      ? NextResponse.json({ accounts: ${acceptedProjection} })
      : NextResponse.json({ rawAccounts: accounts });`,
    `${productionAccepted}\nreturn maybeResponse || NextResponse.json({ rawAccounts: accounts });`,
    `${productionAccepted}\nconst unsafeResponse = NextResponse.json({ rawAccounts: accounts }); return await unsafeResponse;`,
    `${productionAccepted}\nconst response = buildResponse(); return response;`,
    `${productionAccepted}\nlet response = NextResponse.json({ ok: true }); ({ response } = source); return response;`,
    `${productionAccepted}
      let response = NextResponse.json({ accounts: safeProjection });
      if (condition) {
        response = NextResponse.json({ rawAccounts: accounts });
      }
      return response;`,
    `${productionAccepted}
      let response;
      if (condition) {
        response = NextResponse.json({ accounts: safeProjection });
      } else {
        response = NextResponse.json({ rawAccounts: accounts });
      }
      return response;`,
    `${productionAccepted}
      let response = NextResponse.json({ accounts: safeProjection });
      try {
        response = NextResponse.json({ rawAccounts: accounts });
      } catch {}
      return response;`,
    `${productionAccepted}
      const payload = {};
      payload.data = accounts;
      return NextResponse.json(payload);`,
    `${productionAccepted}
      const payload = {};
      payload['token'] = account.accessToken;
      return NextResponse.json(payload);`,
    `${productionAccepted}
      const payload = {};
      payload[key] = accounts;
      return NextResponse.json(payload);`,
    `${productionAccepted}
      const payload = { ok: true };
      payload.data = error;
      return NextResponse.json(payload, { status: 500 });`,
    `${productionAccepted}
      const payload = {};
      payload.data.accounts = accounts;
      return NextResponse.json(payload);`,
    'const projection = accounts.map((account) => account); const response = { accounts: projection }; return NextResponse.json(response);',
    `const decoy = accounts.filter((account) => isSupportedSocialAccountPlatform(account.platform)).map((account) => ({
      id: account.id,
    })); return NextResponse.json({ accounts: accounts.map((account) => account) });`,
  ]) {
    assert.throws(() => assertLinkedAccountSerialization(linkedFixture(fixture)));
  }
});

async function parsedSource(path: string) {
  return parseSource(await readFile(`${repositoryRoot}/${path}`, 'utf8'), path);
}

test('S4b curated browser, route, Stripe, and CLI boundaries retain fixed redaction contracts', async () => {
  const paths = {
    dashboardHome: 'app/(dashboard)/dashboard/home-ui.tsx',
    dashboardPage: 'app/(dashboard)/dashboard/page.tsx',
    projectsPage: 'app/(dashboard)/dashboard/projects/page.tsx',
    sourceAssetForm: 'app/(dashboard)/dashboard/projects/[id]/source-asset-create-form.tsx',
    connect: 'app/api/auth/[platform]/connect/route.ts',
    callback: 'app/api/auth/[platform]/callback/route.ts',
    brandTemplates: 'app/api/brand-templates/route.ts',
    linkedAccounts: 'app/api/linked-accounts/route.ts',
    reusableAssets: 'app/api/reusable-assets/route.ts',
    checkout: 'app/api/stripe/checkout/route.ts',
    webhook: 'app/api/stripe/webhook/route.ts',
    team: 'app/api/team/route.ts',
    user: 'app/api/user/route.ts',
    payments: 'lib/payments/stripe.ts',
    seed: 'lib/db/seed.ts',
    setup: 'lib/db/setup.ts',
  } as const;
  const files = Object.fromEntries(
    await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await parsedSource(path)])),
  ) as Record<keyof typeof paths, ParsedSource>;

  const dashboardHomeStart = findNamedFunction(files.dashboardHome, 'startSubmission');
  const dashboardHomeResume = findNamedFunction(files.dashboardHome, 'handleResumeUpload');
  const dashboardLoad = findNamedFunction(files.dashboardPage, 'loadProjects');
  const projectsLoad = findNamedFunction(files.projectsPage, 'loadProjects');
  const sourceAssetSubmit = findNamedFunction(files.sourceAssetForm, 'handleUploadSubmit');
  const connectGet = findNamedFunction(files.connect, 'GET', true);
  const callbackGet = findNamedFunction(files.callback, 'GET', true);
  const brandTemplatesGet = findNamedFunction(files.brandTemplates, 'GET', true);
  const linkedAccountsGet = findNamedFunction(files.linkedAccounts, 'GET', true);
  const linkedAccountsDelete = findNamedFunction(files.linkedAccounts, 'DELETE', true);
  const reusableAssetsGet = findNamedFunction(files.reusableAssets, 'GET', true);
  const reusableAssetsDelete = findNamedFunction(files.reusableAssets, 'DELETE', true);
  const checkoutGet = findNamedFunction(files.checkout, 'GET', true);
  const webhookPost = findNamedFunction(files.webhook, 'POST', true);
  const teamGet = findNamedFunction(files.team, 'GET', true);
  const userGet = findNamedFunction(files.user, 'GET', true);
  const paymentChange = findNamedFunction(files.payments, 'handleSubscriptionChange', true);

  const providerError = findIfStatement(callbackGet, (expression) => isIdentifier(expression, 'error'));
  const tokenExchangeError = findIfStatement(callbackGet, (expression) => {
    const unwrapped = unwrapParentheses(expression);
    return ts.isPrefixUnaryExpression(unwrapped)
      && unwrapped.operator === ts.SyntaxKind.ExclamationToken
      && isDirectProperty(unwrapped.operand, 'tokenRes', 'ok');
  });

  const boundaries: ReadonlyArray<readonly [ts.Node, 'error' | 'log', string]> = [
    [dashboardHomeStart, 'error', 'Dashboard upload failed.'],
    [dashboardHomeResume, 'error', 'Dashboard upload resume failed.'],
    [dashboardLoad, 'error', 'Unable to load project hub.'],
    [projectsLoad, 'error', 'Unable to load video workspaces.'],
    [findCatchClause(sourceAssetSubmit), 'error', 'Source asset upload failed.'],
    [findCatchClause(connectGet), 'error', 'OAuth initiation failed.'],
    [providerError, 'error', 'OAuth provider returned an error.'],
    [tokenExchangeError, 'error', 'OAuth token exchange failed.'],
    [findCatchClause(callbackGet), 'error', 'OAuth callback failed.'],
    [findCatchClause(brandTemplatesGet), 'error', 'Unable to load brand templates.'],
    [findCatchClause(linkedAccountsGet), 'error', 'Unable to load linked accounts.'],
    [findCatchClause(linkedAccountsDelete), 'error', 'Unable to delete linked account.'],
    [findCatchClause(reusableAssetsGet), 'error', 'Unable to load reusable assets.'],
    [findCatchClause(reusableAssetsDelete), 'error', 'Unable to delete reusable asset.'],
    [findCatchClause(checkoutGet), 'error', 'Stripe checkout completion failed.'],
    [findCatchClause(webhookPost), 'error', 'Webhook signature verification failed.'],
    [findDefaultClause(webhookPost), 'log', 'Unhandled event type.'],
    [teamGet, 'error', 'Unable to load current team.'],
    [userGet, 'error', 'Unable to load current user.'],
    [paymentChange, 'error', 'Team not found for Stripe customer.'],
    [findEstablishedCatchCallback(files.seed, 'seed'), 'error', 'Seed process failed.'],
    [findEstablishedCatchCallback(files.setup, 'main'), 'error', 'Database setup failed.'],
  ];

  for (const [boundary, method, label] of boundaries) {
    assertStaticLog(boundary, method, label);
  }

  const connectCatch = findCatchClause(connectGet);
  assertReturnedCallArguments(
    connectCatch,
    'NextResponse',
    'json',
    ["{ error: 'Internal server error' }", '{ status: 500 }'],
  );

  assertRedirect(providerError, 'oauth_rejected');
  assertRedirect(tokenExchangeError, 'token_exchange_failed');
  assertRedirect(findCatchClause(callbackGet), 'internal_error');

  const accountResponses = handlerReturnedMemberCalls(linkedAccountsGet, 'NextResponse', 'json');
  assert.equal(accountResponses.length, 3, 'GET should retain its unauthorized, account, and failure responses');
  assertLinkedAccountSerialization(files.linkedAccounts);

  const reusableAssetsGetCatch = findCatchClause(reusableAssetsGet);
  const reusableAssetsDeleteCatch = findCatchClause(reusableAssetsDelete);
  for (const [boundary, message] of [
    [reusableAssetsGetCatch, 'Unable to load reusable assets.'],
    [reusableAssetsDeleteCatch, 'Unable to delete reusable asset.'],
  ] as const) {
    assertReturnedCallArguments(boundary, 'Response', 'json', [
      `{ error: '${message}' }`,
      '{ status: 500 }',
    ]);
  }

  const constructEvents = dottedCalls(webhookPost, 'stripe.webhooks.constructEvent');
  assert.equal(constructEvents.length, 1);
  assert.deepEqual(constructEvents[0].arguments.map(compactNode), ['payload', 'signature', 'webhookSecret']);

  const switches = collectNodes(
    webhookPost,
    (node): node is ts.SwitchStatement => ts.isSwitchStatement(node)
      && isDirectProperty(node.expression, 'event', 'type'),
  );
  assert.equal(switches.length, 1);
  const caseValues = switches[0].caseBlock.clauses
    .filter(ts.isCaseClause)
    .map((clause) => compactNode(clause.expression));
  assert.deepEqual(caseValues, ["'customer.subscription.updated'", "'customer.subscription.deleted'"]);
  assert.equal(switches[0].caseBlock.clauses.filter(ts.isDefaultClause).length, 1);

  const subscriptionChanges = namedCalls(switches[0], 'handleSubscriptionChange');
  assert.equal(subscriptionChanges.length, 1);
  assert.ok(ts.isAwaitExpression(subscriptionChanges[0].parent));
  assert.deepEqual(subscriptionChanges[0].arguments.map(compactNode), ['subscription']);

  assertReturnedCallArguments(
    findCatchClause(webhookPost),
    'NextResponse',
    'json',
    ["{ error: 'Webhook signature verification failed.' }", '{ status: 400 }'],
  );
  const webhookResponses = returnedMemberCalls(webhookPost, 'NextResponse', 'json');
  assert.equal(webhookResponses.length, 2);
  assert.equal(
    webhookResponses.filter((call) => call.arguments.length === 1 && compactNode(call.arguments[0]) === '{ received: true }').length,
    1,
  );

  assertReturnedCallArguments(findCatchClause(teamGet), 'Response', 'json', ['null', '{ status: 503 }']);
  assertReturnedCallArguments(findCatchClause(userGet), 'Response', 'json', ['null', '{ status: 503 }']);
  assertReturnedCallArguments(
    findCatchClause(checkoutGet),
    'NextResponse',
    'redirect',
    ["new URL('/error', request.url)"],
  );
});
