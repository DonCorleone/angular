/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {Attribute, Element, HtmlParser, Node, ParseTreeResult, RecursiveVisitor, visitAll} from '@angular/compiler';
import {dirname, join} from 'path';
import ts from 'typescript';

const ngif = '*ngIf';
const ngfor = '*ngFor';
const ngswitch = '[ngSwitch]';
const attributesToMigrate = [
  ngif,
  ngfor,
  ngswitch,
];

const casesToMigrate = [
  '*ngSwitchCase',
  '*ngSwitchDefault',
];

/**
 * Represents a range of text within a file. Omitting the end
 * means that it's until the end of the file.
 */
type Range = [start: number, end?: number];

/**
 * Represents an element with a migratable attribute
 */
class ElementToMigrate {
  el: Element;
  attr: Attribute;
  nestCount = 0;

  constructor(el: Element, attr: Attribute) {
    this.el = el;
    this.attr = attr;
  }

  getCondition(targetStr: string): string {
    const targetLocation = this.attr.value.indexOf(targetStr);
    return this.attr.value.slice(0, targetLocation);
  }

  getTemplateName(targetStr: string, secondStr?: string): string {
    const targetLocation = this.attr.value.indexOf(targetStr);
    if (secondStr) {
      const secondTargetLocation = this.attr.value.indexOf(secondStr);
      return this.attr.value.slice(targetLocation + targetStr.length, secondTargetLocation).trim();
    }
    return this.attr.value.slice(targetLocation + targetStr.length).trim();
  }

  start(offset: number): number {
    return this.el.sourceSpan?.start.offset - this.nestCount - offset;
  }

  end(offset: number): number {
    return this.el.sourceSpan?.end.offset - this.nestCount - offset;
  }

  length(): number {
    return this.el.sourceSpan.end.offset - this.el.sourceSpan.start.offset;
  }

  openLength(): number {
    return this.el.children[0].sourceSpan.start.offset - this.el.sourceSpan.start.offset;
  }

  closeLength(): number {
    return this.el.sourceSpan.end.offset - this.el.children[0].sourceSpan.end.offset;
  }

  preOffset(newOffset: number): number {
    return newOffset - this.openLength() + 1;
  }

  postOffset(newOffset: number): number {
    return newOffset - this.closeLength();
  }
}

class Template {
  el: Element;
  count: number = 0;
  contents: string = '';
  children: string = '';

  constructor(el: Element) {
    this.el = el;
  }

  generateContents(tmpl: string) {
    this.contents = tmpl.slice(this.el.sourceSpan.start.offset, this.el.sourceSpan.end.offset + 1);
    this.children = tmpl.slice(
        this.el.children[0].sourceSpan.start.offset,
        this.el.children[this.el.children.length - 1].sourceSpan.end.offset);
  }
}

/** Represents a file that was analyzed by the migration. */
export class AnalyzedFile {
  private ranges: Range[] = [];

  /** Returns the ranges in the order in which they should be migrated. */
  getSortedRanges(): Range[] {
    return this.ranges.slice().sort(([aStart], [bStart]) => bStart - aStart);
  }

  /**
   * Adds a text range to an `AnalyzedFile`.
   * @param path Path of the file.
   * @param analyzedFiles Map keeping track of all the analyzed files.
   * @param range Range to be added.
   */
  static addRange(path: string, analyzedFiles: Map<string, AnalyzedFile>, range: Range): void {
    let analysis = analyzedFiles.get(path);

    if (!analysis) {
      analysis = new AnalyzedFile();
      analyzedFiles.set(path, analysis);
    }

    const duplicate =
        analysis.ranges.find(current => current[0] === range[0] && current[1] === range[1]);

    if (!duplicate) {
      analysis.ranges.push(range);
    }
  }
}

/**
 * Analyzes a source file to find file that need to be migrated and the text ranges within them.
 * @param sourceFile File to be analyzed.
 * @param analyzedFiles Map in which to store the results.
 */
export function analyze(sourceFile: ts.SourceFile, analyzedFiles: Map<string, AnalyzedFile>) {
  for (const node of sourceFile.statements) {
    if (!ts.isClassDeclaration(node)) {
      continue;
    }

    // Note: we have a utility to resolve the Angular decorators from a class declaration already.
    // We don't use it here, because it requires access to the type checker which makes it more
    // time-consuming to run internally.
    const decorator = ts.getDecorators(node)?.find(dec => {
      return ts.isCallExpression(dec.expression) && ts.isIdentifier(dec.expression.expression) &&
          dec.expression.expression.text === 'Component';
    }) as (ts.Decorator & {expression: ts.CallExpression}) |
        undefined;

    const metadata = decorator && decorator.expression.arguments.length > 0 &&
            ts.isObjectLiteralExpression(decorator.expression.arguments[0]) ?
        decorator.expression.arguments[0] :
        null;

    if (!metadata) {
      continue;
    }

    for (const prop of metadata.properties) {
      // All the properties we care about should have static
      // names and be initialized to a static string.
      if (!ts.isPropertyAssignment(prop) || !ts.isStringLiteralLike(prop.initializer) ||
          (!ts.isIdentifier(prop.name) && !ts.isStringLiteralLike(prop.name))) {
        continue;
      }

      switch (prop.name.text) {
        case 'template':
          // +1/-1 to exclude the opening/closing characters from the range.
          AnalyzedFile.addRange(
              sourceFile.fileName, analyzedFiles,
              [prop.initializer.getStart() + 1, prop.initializer.getEnd() - 1]);
          break;

        case 'templateUrl':
          // Leave the end as undefined which means that the range is until the end of the file.
          const path = join(dirname(sourceFile.fileName), prop.initializer.text);
          AnalyzedFile.addRange(path, analyzedFiles, [0]);
          break;
      }
    }
  }
}

/**
 * returns the level deep a migratable element is nested
 */
function getNestedCount(etm: ElementToMigrate, aggregator: number[]) {
  if (aggregator.length === 0) {
    return 0;
  }
  if (etm.el.sourceSpan.start.offset < aggregator[aggregator.length - 1] &&
      etm.el.sourceSpan.end.offset !== aggregator[aggregator.length - 1]) {
    // element is nested
    aggregator.push(etm.el.sourceSpan.end.offset);
    return aggregator.length - 1;
  } else {
    // not nested
    aggregator.pop()!;
    return getNestedCount(etm, aggregator);
  }
}

/**
 * Replaces structural directive control flow instances with block control flow equivalents.
 * Returns null if the migration failed (e.g. there was a syntax error).
 */
export function migrateTemplate(template: string): string|null {
  let parsed: ParseTreeResult;
  try {
    // Note: we use the HtmlParser here, instead of the `parseTemplate` function, because the
    // latter returns an Ivy AST, not an HTML AST. The HTML AST has the advantage of preserving
    // interpolated text as text nodes containing a mixture of interpolation tokens and text tokens,
    // rather than turning them into `BoundText` nodes like the Ivy AST does. This allows us to
    // easily get the text-only ranges without having to reconstruct the original text.
    parsed = new HtmlParser().parse(template, '', {
      // Allows for ICUs to be parsed.
      tokenizeExpansionForms: true,
      // Explicitly disable blocks so that their characters are treated as plain text.
      tokenizeBlocks: false,
    });

    // Don't migrate invalid templates.
    if (parsed.errors && parsed.errors.length > 0) {
      return null;
    }
  } catch {
    return null;
  }

  let result = template;
  const visitor = new ElementCollector();
  visitAll(visitor, parsed.rootNodes);

  // count usages of each ng-template
  for (let [key, tmpl] of visitor.templates) {
    const regex = new RegExp(`\\W${key.slice(1)}\\W`, 'gm');
    const matches = template.match(regex);
    tmpl.count = matches?.length ?? 0;
    tmpl.generateContents(template);
  }

  // start from top of template
  // loop through each element
  let prevElEnd = visitor.elements[0]?.el.sourceSpan.end.offset ?? result.length - 1;
  let nestedQueue: number[] = [prevElEnd];
  for (let i = 1; i < visitor.elements.length; i++) {
    let currEl = visitor.elements[i];
    currEl.nestCount = getNestedCount(currEl, nestedQueue);
  }

  // this tracks the character shift from different lengths of blocks from
  // the prior directives so as to adjust for nested block replacement during
  // migration. Each block calculates length differences and passes that offset
  // to the next migrating block to adjust character offsets properly.
  let offset = 0;

  for (const el of visitor.elements) {
    // these are all migratable nodes

    if (el.attr.name === ngif) {
      let ifResult = migrateNgIf(el, visitor.templates, result, offset);
      result = ifResult.tmpl;
      offset = ifResult.offset;
    } else if (el.attr.name === ngfor) {
      let forResult = migrateNgFor(el, result, offset);
      result = forResult.tmpl;
      offset = forResult.offset;
    } else if (el.attr.name === ngswitch) {
      let switchResult = migrateNgSwitch(el, result, offset);
      result = switchResult.tmpl;
      offset = switchResult.offset;
    }
  }

  for (const [_, t] of visitor.templates) {
    if (t.count === 2) {
      result = result.replace(t.contents, '');
    }
  }

  return result;
}

function migrateNgFor(
    etm: ElementToMigrate, tmpl: string, offset: number): {tmpl: string, offset: number} {
  const aliasRegexp = /=\s+(count|index|first|last|even|odd)/gm;
  const aliases = [];

  const parts = etm.attr.value.split(';');

  // first portion should always be the loop definition prefixed with `let`
  const condition = parts[0].replace('let ', '');
  const loopVar = condition.split(' of ')[0];
  let trackBy = loopVar;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i].trim();

    if (part.startsWith('trackBy:')) {
      // build trackby value
      const trackByFn = part.replace('trackBy:', '').trim();
      trackBy = `${trackByFn}($index, ${loopVar})`;
    }
    // aliases
    if (part.match(aliasRegexp)) {
      const aliasParts = part.split('=');
      aliases.push(` ${aliasParts[0].trim()} = $${aliasParts[1].trim()}`);
    }
  }

  const aliasStr = (aliases.length > 0) ? `;${aliases.join(';')}` : '';

  const startBlock = `@for (${condition}; track ${trackBy}${aliasStr}) {`;

  const mainBlock = getMainBlock(etm, tmpl, offset);
  const forBlock = startBlock + mainBlock + '}';

  const updatedTmpl = tmpl.slice(0, etm.start(offset)) + forBlock + tmpl.slice(etm.end(offset));

  offset = offset + etm.length() - forBlock.length;

  return {tmpl: updatedTmpl, offset};
}

function migrateNgIf(
    etm: ElementToMigrate, ngTemplates: Map<string, Template>, tmpl: string,
    offset: number): {tmpl: string, offset: number} {
  const matchThen = etm.attr.value.match(/;\s+then/gm);
  const matchElse = etm.attr.value.match(/;\s+else/gm);

  if (matchThen && matchThen.length > 0) {
    return buildIfThenElseBlock(etm, ngTemplates, tmpl, matchThen[0], matchElse![0], offset);
  } else if (matchElse && matchElse.length > 0) {
    // just else
    return buildIfElseBlock(etm, ngTemplates, tmpl, matchElse[0], offset);
  }

  return buildIfBlock(etm, tmpl, offset);
}

function buildIfBlock(
    etm: ElementToMigrate, tmpl: string, offset: number): {tmpl: string, offset: number} {
  const condition = etm.attr.value;
  const startBlock = `@if (${condition}) {`;

  const ifBlock = startBlock + getMainBlock(etm, tmpl, offset) + `}`;
  const updatedTmpl = tmpl.slice(0, etm.start(offset)) + ifBlock + tmpl.slice(etm.end(offset));

  offset = offset + etm.length() - ifBlock.length;

  return {tmpl: updatedTmpl, offset};
}

function buildIfElseBlock(
    etm: ElementToMigrate, ngTemplates: Map<string, Template>, tmpl: string, elseString: string,
    offset: number): {tmpl: string, offset: number} {
  const condition = etm.getCondition(elseString);

  const elseTmpl = ngTemplates.get(`#${etm.getTemplateName(elseString)}`)!;
  const startBlock = `@if (${condition}) {`;
  const mainBlock = getMainBlock(etm, tmpl, offset);
  const elseBlock = `} @else {`;
  const postBlock = elseBlock + elseTmpl.children + '}';
  const ifElseBlock = startBlock + mainBlock + postBlock;

  let tmplStart = tmpl.slice(0, etm.start(offset));
  let tmplEnd = tmpl.slice(etm.end(offset));
  const updatedTmpl = tmplStart + ifElseBlock + tmplEnd;

  offset = offset + etm.preOffset(startBlock.length) +
      etm.postOffset(mainBlock.length + postBlock.length);

  return {tmpl: updatedTmpl, offset};
}

function buildIfThenElseBlock(
    etm: ElementToMigrate, ngTemplates: Map<string, Template>, tmpl: string, thenString: string,
    elseString: string, offset: number): {tmpl: string, offset: number} {
  const condition = etm.getCondition(thenString);

  const startBlock = `@if (${condition}) {`;
  const elseBlock = `} @else {`;

  const thenTmpl = ngTemplates.get(`#${etm.getTemplateName(thenString, elseString)}`)!;
  const elseTmpl = ngTemplates.get(`#${etm.getTemplateName(elseString)}`)!;

  const postBlock = thenTmpl.children + elseBlock + elseTmpl.children + '}';
  const ifThenElseBlock = startBlock + postBlock;

  let tmplStart = tmpl.slice(0, etm.start(offset));
  let tmplEnd = tmpl.slice(etm.end(offset));

  const updatedTmpl = tmplStart + ifThenElseBlock + tmplEnd;

  offset = offset + etm.preOffset(startBlock.length) + etm.postOffset(postBlock.length);

  return {tmpl: updatedTmpl, offset};
}

function getMainBlock(etm: ElementToMigrate, tmpl: string, offset: number) {
  if (etm.el.name === 'ng-container' && etm.el.attrs.length === 1 && etm.attr.name === ngfor) {
    // this is the case where we're migrating an ngFor and there's no need to keep the ng-container
    const childStart = etm.el.children[0].sourceSpan.start.offset - etm.nestCount - offset;
    const childEnd =
        etm.el.children[etm.el.children.length - 1].sourceSpan.end.offset - etm.nestCount - offset;
    return tmpl.slice(childStart, childEnd);
  }
  const attrStart = etm.attr.keySpan!.start.offset - 1 - etm.nestCount - offset;
  const valEnd = etm.attr.valueSpan!.end.offset + 1 - etm.nestCount - offset;
  const start = tmpl.slice(etm.start(offset), attrStart);
  const end = tmpl.slice(valEnd, etm.end(offset));
  return start + end;
}

function migrateNgSwitch(
    etm: ElementToMigrate, tmpl: string, offset: number): {tmpl: string, offset: number} {
  const condition = etm.attr.value;
  const startBlock = `@switch (${condition}) { `;

  const {openTag, closeTag, children} = getSwitchBlockElements(etm, tmpl, offset);
  const cases = getSwitchCases(children, tmpl, etm.nestCount, offset);
  const switchBlock = openTag + startBlock + cases.join(' ') + `}` + closeTag;
  const updatedTmpl = tmpl.slice(0, etm.start(offset)) + switchBlock + tmpl.slice(etm.end(offset));

  const difference = etm.length() - switchBlock.length;

  offset = offset + difference;

  return {tmpl: updatedTmpl, offset};
}

function getSwitchBlockElements(etm: ElementToMigrate, tmpl: string, offset: number) {
  const attrStart = etm.attr.keySpan!.start.offset - 1 - etm.nestCount - offset;
  const valEnd = etm.attr.valueSpan!.end.offset + 1 - etm.nestCount - offset;
  const childStart = etm.el.children[0].sourceSpan.start.offset - etm.nestCount - offset;
  const childEnd =
      etm.el.children[etm.el.children.length - 1].sourceSpan.end.offset - etm.nestCount - offset;
  let openTag = tmpl.slice(etm.start(offset), attrStart) + tmpl.slice(valEnd, childStart);
  if (tmpl.slice(childStart, childStart + 1) === '\n') {
    openTag += '\n';
  }
  let closeTag = tmpl.slice(childEnd, etm.end(offset));
  if (tmpl.slice(childEnd - 1, childEnd) === '\n') {
    closeTag = '\n' + closeTag;
  }
  return {
    openTag,
    closeTag,
    children: etm.el.children,
  };
}

function getSwitchCases(children: Node[], tmpl: string, nestCount: number, offset: number) {
  const collector = new CaseCollector();
  visitAll(collector, children);
  return collector.elements.map(etm => getSwitchCaseBlock(etm, tmpl, nestCount, offset));
}

function getSwitchCaseBlock(
    etm: ElementToMigrate, tmpl: string, nestCount: number, offset: number): string {
  const elStart = etm.el.sourceSpan?.start.offset - nestCount - offset;
  const elEnd = etm.el.sourceSpan?.end.offset - nestCount - offset;
  // beginning of the ngIf minus a leading space
  const attrStart = etm.attr.keySpan!.start.offset - 1 - nestCount - offset;
  // ngSwitchDefault case has no valueSpan and relies on the end of the key
  const attrEnd = etm.attr.keySpan!.end.offset - nestCount - offset;
  if (etm.attr.name === '*ngSwitchDefault') {
    return `@default { ${tmpl.slice(elStart, attrStart) + tmpl.slice(attrEnd, elEnd)} }`;
  }
  // ngSwitchCase has a valueSpan
  const valEnd = etm.attr.valueSpan!.end.offset + 1 - nestCount - offset;
  return `@case (${etm.attr.value}) { ${
      tmpl.slice(elStart, attrStart) + tmpl.slice(valEnd, elEnd)} }`;
}

/** Finds all elements with control flow structural directives. */
class ElementCollector extends RecursiveVisitor {
  readonly elements: ElementToMigrate[] = [];
  readonly templates: Map<string, Template> = new Map();

  override visitElement(el: Element): void {
    if (el.attrs.length > 0) {
      for (const attr of el.attrs) {
        if (attributesToMigrate.includes(attr.name)) {
          this.elements.push(new ElementToMigrate(el, attr));
        }
      }
    }
    if (el.name === 'ng-template') {
      for (const attr of el.attrs) {
        if (attr.name.startsWith('#')) {
          this.elements.push(new ElementToMigrate(el, attr));
          this.templates.set(attr.name, new Template(el));
        }
      }
    }
    super.visitElement(el, null);
  }
}

class CaseCollector extends RecursiveVisitor {
  readonly elements: ElementToMigrate[] = [];

  override visitElement(el: Element): void {
    if (el.attrs.length > 0) {
      for (const attr of el.attrs) {
        if (casesToMigrate.includes(attr.name)) {
          this.elements.push(new ElementToMigrate(el, attr));
        }
      }
    }

    super.visitElement(el, null);
  }
}
