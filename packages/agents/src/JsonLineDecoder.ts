export class JsonLineDecoder {
  private remainder = "";

  push(chunk: string): unknown[] {
    this.remainder += chunk;
    const lines = this.remainder.split("\n");
    this.remainder = lines.pop() ?? "";
    return lines.flatMap((line) => this.parse(line));
  }

  flush(): unknown[] {
    const line = this.remainder;
    this.remainder = "";
    return this.parse(line);
  }

  private parse(line: string): unknown[] {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [{ type: "unparsed", raw: line }];
    }
  }
}

