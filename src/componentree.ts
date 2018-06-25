import glob from 'glob-promise';

export interface ComponentreeConfiguration {
    base?: string;
    logging?: boolean;
    errorHandler?: (e: any) => any;
}

interface Thing {
    new(): any;
    bootload: boolean;
    service: boolean;
    tags: string[];
}

const defaultConfiguration = {
    base: 'c'
}

@service
export class Componentree {
    components: Map<string, Thing> = new Map([[Componentree.name, <Thing>Componentree]]);
    protected instances: any[] = [];
    protected services: Map<string, any> = new Map([[Componentree.name, this]]);

    constructor(private config: ComponentreeConfiguration = defaultConfiguration) {
        this.config = { ...defaultConfiguration, ...this.config };
        global.register = this.Register.bind(this);
        (async () => {
            console.log(process.cwd());
            const filesLoaded = (await glob(`**/*.${this.config.base}.js`)).map(file => require(`${process.cwd()}/${file}`) && this.Log(`Loaded ${file}`)).length;
            if (filesLoaded === 0) this.Log('Loaded 0 files! 😱');
            Array.from(this.components.values()).map(component => component.bootload && this.instances.push(this.Inject(component)));
        })().catch(e => this.config.errorHandler instanceof Function ? this.config.errorHandler(e) : console.log(e.stack || e));
    }

    protected Log(message: any, ...optionalParams: any[]) {
        if (this.config.logging) console.log.apply(undefined, arguments);
    }

    Register(component: { new(): any }) {
        this.components.set(component.name, <Thing>component);
    }
    // NOTE Tidy up and compact inject method
    protected Inject(t: Thing) {
        const injections: Object[] = [];
        const matches = t.toString().match(/constructor.*?\(([^)]*)\)/);
        if (matches && matches.length === 2) {
            const injectionNames = matches[1].replace(/\s/g, '').split(',').filter(n => n.length > 0);
            injectionNames.map(name => {
                // NOTE this tries to access tags before checking that it's a registered component!
                // NOTE add file where class is in to this error. We should track sources of components, too.
                if (!this.components.has(name)) throw new Error(`Could not find component: ${name} in component ${t.name}`);
                if (this.components.get(name)!.service) {
                    if (!this.services.get(name)) this.services.set(name, this.Inject(this.components.get(name)!));
                    injections.push(this.services.get(name));
                } else {
                    injections.push(this.Inject(this.components.get(name)!));
                }
            });
        }
        return Reflect.construct(t, injections);
    }

    protected SafelyGetComponent(name: string) {
        if (!this.components.has(name)) throw new Error(`Could not find component: ${name}`)
        return this.components.get(name)!;
    }

    public Get(name: string) {
        return this.SafelyGetComponent(name);
    }

    public GetInstance<T>(component: Thing): T {
        return this.Inject(component);
    }

    public FindByTags(...tags: string[]) {
        return Array.from(this.components.values()).filter(component => component.tags.length !== 0 && component.tags.every(tag => tags.indexOf(tag) !== -1));
    }

    public FindByInheritance(inherits: any, ...tags: string[]) {
        return Array.from(this.components.values()).filter(component => component.prototype instanceof inherits && (tags.length === 0 || component.tags.every(tag => tags.indexOf(tag) !== -1)));
    }
}

// NOTE improve all decorators to use a common metadata function
export function component(t: any) {
    t.type = 'component'
    t.tags = [];
    global.register(t);
}

export function bootload(t: any) {
    t.bootload = true;
}

export function service(t: any) {
    t.service = true;
}

export function tag(...tags: string[]) {
    return (t: any) => {
        (t.tags || (t.tags = [])) && (t.tags = t.tags.concat(tags));
    }
}