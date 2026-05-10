import { useEffect, useRef } from 'react';

const SPEED = 2.5;
const SIZE = 50;
const MIN_ANGULAR_VELOCITY = 0.1;

const imageList = [
  '/publicly_available_goodies/eliash.png',
  '/publicly_available_goodies/eliasl.png',
  '/publicly_available_goodies/erikh.png',
  '/publicly_available_goodies/erikl.png',
  '/publicly_available_goodies/jorgenr.png',
  '/publicly_available_goodies/vetleh.png',
];

type Obj = {
  element: HTMLImageElement;
  x: number;
  y: number;
  dx: number;
  dy: number;
  mass: number;
  angle: number;
  angularVelocity: number;
};

export function BouncingHeads() {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    const chosenImages: string[] = [];

    while (chosenImages.length < 3) {
      const random =
        imageList[Math.floor(Math.random() * imageList.length)];

      if (!chosenImages.includes(random)) {
        chosenImages.push(random);
      }
    }

    const bouncingObjects: Obj[] = chosenImages.map((src, index) => {
      const img = new Image();

      img.src = src;
      img.className = 'bouncing-head';

      box.appendChild(img);

      const initialAngularVelocity =
        (Math.random() - 0.5) * 0.4 + MIN_ANGULAR_VELOCITY;

      const angularVelocity =
        Math.random() < 0.5
          ? initialAngularVelocity
          : -initialAngularVelocity;

      return {
        element: img,
        x: Math.random() * (box.offsetWidth - SIZE),
        y: Math.random() * (box.offsetHeight - SIZE),
        dx: (Math.random() < 0.5 ? -1 : 1) * SPEED,
        dy: (Math.random() < 0.5 ? -1 : 1) * SPEED,
        mass: 1,
        angle: 0,
        angularVelocity,
      };
    });

    function isColliding(obj1: Obj, obj2: Obj) {
      const dx = obj1.x + SIZE / 2 - (obj2.x + SIZE / 2);
      const dy = obj1.y + SIZE / 2 - (obj2.y + SIZE / 2);

      const distance = Math.sqrt(dx * dx + dy * dy);

      return distance < SIZE;
    }

    function handleElasticCollision(obj1: Obj, obj2: Obj) {
      const dx = obj1.x - obj2.x;
      const dy = obj1.y - obj2.y;

      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < 0.01) return;

      const nx = dx / distance;
      const ny = dy / distance;

      const tx = -ny;
      const ty = nx;

      const dpTan1 = obj1.dx * tx + obj1.dy * ty;
      const dpTan2 = obj2.dx * tx + obj2.dy * ty;

      const dpNorm1 = obj1.dx * nx + obj1.dy * ny;
      const dpNorm2 = obj2.dx * nx + obj2.dy * ny;

      const m1 = obj1.mass;
      const m2 = obj2.mass;

      const v1 =
        (dpNorm1 * (m1 - m2) + 2 * m2 * dpNorm2) / (m1 + m2);

      const v2 =
        (dpNorm2 * (m2 - m1) + 2 * m1 * dpNorm1) / (m1 + m2);

      obj1.dx = tx * dpTan1 + nx * v1;
      obj1.dy = ty * dpTan1 + ny * v1;

      obj2.dx = tx * dpTan2 + nx * v2;
      obj2.dy = ty * dpTan2 + ny * v2;

      const totalAngularMomentum =
        obj1.angularVelocity * obj1.mass +
        obj2.angularVelocity * obj2.mass;

      const avgAngularVelocity =
        totalAngularMomentum / (obj1.mass + obj2.mass);

      obj1.angularVelocity =
        avgAngularVelocity + (Math.random() - 0.5) * 0.05;

      obj2.angularVelocity =
        avgAngularVelocity + (Math.random() - 0.5) * 0.05;

        const overlap = SIZE - distance;

        if (overlap > 0) {
          const correction = overlap / 2;

          obj1.x += nx * correction;
          obj1.y += ny * correction;

          obj2.x -= nx * correction;
          obj2.y -= ny * correction;
        }
    }

    let animationFrame: number;

    function move() {
      bouncingObjects.forEach((object) => {
        object.x += object.dx;
        object.y += object.dy;

        if (object.x <= 0 || object.x >= box.offsetWidth - SIZE) {
          object.dx = -object.dx;
        }

        if (object.y <= 0 || object.y >= box.offsetHeight - SIZE) {
          object.dy = -object.dy;
        }

        // FIXME: there is still some tomfoolery with right and bottom edges

        object.angle += object.angularVelocity;

        object.element.style.left = `${object.x}px`;
        object.element.style.top = `${object.y}px`;
        object.element.style.transform = `rotate(${object.angle}rad)`;
      });

      for (let i = 0; i < bouncingObjects.length; i++) {
        for (let j = i + 1; j < bouncingObjects.length; j++) {
          if (isColliding(bouncingObjects[i], bouncingObjects[j])) {
            handleElasticCollision(
              bouncingObjects[i],
              bouncingObjects[j]
            );
          }
        }
      }

      animationFrame = requestAnimationFrame(move);
    }

    animationFrame = requestAnimationFrame(move);

    return () => {
      cancelAnimationFrame(animationFrame);

      bouncingObjects.forEach((obj) => {
        obj.element.remove();
      });
    };
  }, []);

  return <div className="bouncing-box" ref={boxRef} />;
}