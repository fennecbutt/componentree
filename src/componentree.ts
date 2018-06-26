import glob from 'glob-promise';

export interface ComponentreeConfiguration {
    base?: string;
    debug?: boolean;
    errorHandler?: (e: any) => any;
}

export interface Component {
    new(): any;
    service: boolean;
    tags: string[];
}

interface ComponentContainer {
    component: Component;
    source: String | null;
}

function MakeComponentContainer(component: Component, source: String | null = null): ComponentContainer {
    return {
        component,
        source: source
    }
}

const defaultConfiguration = {
    base: 'c'
}

@service
export class Componentree {
    components: Map<string, ComponentContainer> = new Map([[Componentree.name, MakeComponentContainer(<Component>Componentree, __filename)]]);
    protected instances: any[] = [];
    protected services: Map<string, any> = new Map([[Componentree.name, this]]);

    constructor(private config: ComponentreeConfiguration = defaultConfiguration) {
        this.config = { ...defaultConfiguration, ...this.config };
        global.register = this.Register.bind(this);
        (async () => {
            console.log(process.cwd());
            const filesLoaded = (await glob(`**/*.${this.config.base}.js`)).map(file => require(`${process.cwd()}/${file}`) && this.Log(`Loaded ${file}`)).length;
            if (filesLoaded === 0) this.Log('Loaded 0 files!');
            Array.from(this.components.values()).map(container => container.component.service && this.instances.push(this.Inject(container.component)));
        })().catch(e => this.config.errorHandler instanceof Function ? this.config.errorHandler(e) : console.log(e.stack || e));
    }

    protected Log(message: any, ...optionalParams: any[]) {
        if (this.config.debug) console.log.apply(undefined, arguments);
    }

    Register(component: { new(): any }, source: String | null = null) {
        this.components.set(component.name, MakeComponentContainer(<Component>component, source));
    }

    protected Inject(t: Component) {
        const injections: Object[] = [];
        const matches = t.toString().match(/constructor.*?\(([^)]*)\)/);
        if (matches && matches.length === 2) {
            const injectionNames = matches[1].replace(/\s/g, '').split(',').filter(n => n.length > 0);
            injectionNames.map(name => {
                // NOTE this tries to access tags before checking that it's a registered component!
                /**
                 * NOTE source tracking for components is implemented by the source property in
                 * ComponentContainer, but I haven't thought of a good way of how to get it yet
                 * since components autonomously register. For the moment the stack trace will suffice.
                 */
                if (!this.components.has(name)) throw new Error(`Could not find component: ${name} in component ${t.name}`);
                if (this.components.get(name)!.component.service) {
                    if (!this.services.get(name)) this.services.set(name, this.Inject(this.components.get(name)!.component));
                    injections.push(this.services.get(name));
                } else {
                    injections.push(this.Inject(this.components.get(name)!.component));
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

    public GetInstance<T>(component: Component): T {
        return this.Inject(component);
    }

    public GetByTags(...tags: string[]) {
        return Array.from(this.components.values()).filter(container => container.component.tags.length !== 0 && container.component.tags.every(tag => tags.indexOf(tag) !== -1));
    }

    public GetByInheritance(inherits: any, ...tags: string[]) {
        return Array.from(this.components.values()).filter(container => container.component.prototype instanceof inherits && (tags.length === 0 || container.component.tags.every(tag => tags.indexOf(tag) !== -1)));
    }
}

// NOTE change all decorators to use a common metadata function, expose this to components to help them modify component metadata in a protected way
export function component(t: any) {
    t.type = 'component'
    t.tags = [];
    global.register(t);
}

export function service(t: any) {
    t.service = true;
}

export function tag(...tags: string[]) {
    return (t: any) => {
        (t.tags || (t.tags = [])) && (t.tags = t.tags.concat(tags));
    }
}